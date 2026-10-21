'use strict';

// #4087 PR-4: the read-only service route that serves a published public trust
// receipt's canonical bytes. A third party that read a publicReceiptId and
// checksum off a check run fetches the exact bytes here and hands them to
// `importPublicTrustReceipt`. This route only reads: it never signs, never
// re-encodes, and never writes.
//
// The id in the path is validated as 64 lowercase hex BEFORE the store is
// touched, and it is never turned into a filesystem path: the store locates the
// record by scanning its own directory and matching the record's own
// publicReceiptId, so no request-controlled string reaches `path.join`. That is
// the path-traversal defense -- there is no traversal surface to defend.
//
// The bytes are re-derived from the stored receipt by the exporter's own
// `toCanonicalPublicReceiptBytes`, which re-checks the public receipt shape and
// checksum and fails closed. A stored record that no longer canonicalizes is a
// 500, not a served body: a verifier must never receive bytes this process
// could not itself validate.

const { toCanonicalPublicReceiptBytes } = require('../receipt/public-trust-receipt');
const { checkRateLimit } = require('../../requestGuards-rate-limit');
const { descriptor, bytesDescriptor } = require('../github-app-beta-http-responses');

const PUBLIC_RECEIPT_PATH_PREFIX = '/public-receipts/';
const PUBLIC_RECEIPT_ID_PATTERN = /^[0-9a-f]{64}$/;
const CANONICAL_BYTES_CONTENT_TYPE = 'application/json; charset=utf-8';

// The path segment is used only as a lookup key, so it is read verbatim rather
// than percent-decoded: a publicReceiptId is hex, so any encoding is either a
// no-op or a value that must fail the pattern.
function parsePublicReceiptId(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith(PUBLIC_RECEIPT_PATH_PREFIX)) return null;
  return pathname.slice(PUBLIC_RECEIPT_PATH_PREFIX.length);
}

function defaultRateLimit(req) {
  const key = String(req?.socket?.remoteAddress || 'unknown');
  return checkRateLimit(key);
}

/**
 * @param {object} deps
 * @param {(publicReceiptId: string) => (object|null)} deps.readPublicReceipt
 *   the C8 store reader; returns the stored record or null, and throws on IO.
 * @param {(req: object) => boolean} [deps.rateLimit]
 */
function createPublicReceiptRoute({ readPublicReceipt, rateLimit = defaultRateLimit } = {}) {
  if (typeof readPublicReceipt !== 'function') {
    throw new TypeError('readPublicReceipt is required');
  }

  async function handle(req, reqUrl) {
    if (!req || req.method !== 'GET') {
      return descriptor(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED' } }, { Allow: 'GET' });
    }
    if (!rateLimit(req)) {
      return descriptor(429, { ok: false, error: { code: 'RATE_LIMITED' } }, { 'Retry-After': '60' });
    }
    const publicReceiptId = parsePublicReceiptId(reqUrl && reqUrl.pathname);
    if (publicReceiptId === null || !PUBLIC_RECEIPT_ID_PATTERN.test(publicReceiptId)) {
      return descriptor(400, { ok: false, error: { code: 'PUBLIC_RECEIPT_ID_INVALID' } });
    }

    let record;
    try {
      record = readPublicReceipt(publicReceiptId);
    } catch (_) {
      return descriptor(500, { ok: false, error: { code: 'PUBLIC_RECEIPT_READ_FAILED' } });
    }
    if (!record) {
      return descriptor(404, { ok: false, error: { code: 'PUBLIC_RECEIPT_NOT_FOUND' } });
    }

    let bytes;
    try {
      bytes = toCanonicalPublicReceiptBytes(record.publicReceipt);
    } catch (_) {
      return descriptor(500, { ok: false, error: { code: 'PUBLIC_RECEIPT_INVALID' } });
    }
    return bytesDescriptor(200, bytes, { 'Content-Type': CANONICAL_BYTES_CONTENT_TYPE });
  }

  return Object.freeze({
    prefix: PUBLIC_RECEIPT_PATH_PREFIX,
    method: 'GET',
    handle,
  });
}

module.exports = Object.freeze({
  PUBLIC_RECEIPT_PATH_PREFIX,
  PUBLIC_RECEIPT_ID_PATTERN,
  createPublicReceiptRoute,
});
