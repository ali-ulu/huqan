'use strict';

/**
 * Request-parsing helpers for the trust-receipt HTTP surface.
 *
 * Pure functions over a URL / pathname: they read and length-clamp query
 * parameters and pull a receipt id out of a path. No I/O, no kernel access, no
 * authorization decisions -- the caller still owns all of that.
 *
 * Lifted out of server.js because that file is over the large-file threshold
 * recorded in scripts/file-size-baseline.json and the ratchet in
 * scripts/check-file-size.js forbids growing it further. This block was chosen
 * precisely because it is not part of the security surface: moving CORS,
 * rate-limiting or authorization code to satisfy a line count would be trading
 * a real risk for a cosmetic one.
 */

const { sanitizeInput } = require('../requestGuards');

const TRUST_FILTER_MAX_ID = 128;
const TRUST_FILTER_MAX_REF = 256;
const TRUST_FILTER_MAX_ENUM = 32;
const TRUST_RECEIPT_READ_PREFIX = '/api/trust-receipt/';

function readTrustFilters(reqUrl) {
  const params = reqUrl.searchParams;
  const readId = (name) => sanitizeInput(params.get(name) || '', TRUST_FILTER_MAX_ID);
  const readRef = (name) => sanitizeInput(params.get(name) || '', TRUST_FILTER_MAX_REF);
  const readEnum = (name) => sanitizeInput(params.get(name) || '', TRUST_FILTER_MAX_ENUM);
  return {
    workspaceId: readId('workspaceId'),
    targetId: readId('targetId'),
    provenanceId: readId('provenanceId'),
    sourceRef: readRef('sourceRef'),
    sourceType: readEnum('sourceType'),
    sourceSubType: readEnum('sourceSubType'),
    actor: readId('actor'),
    eventType: readEnum('eventType'),
    candidateId: readId('candidateId'),
    status: readEnum('status'),
    recommendation: readEnum('recommendation'),
    order: readEnum('order'),
    targetType: readEnum('targetType'),
  };
}

function hasTrustQuery(filters, keys) {
  return keys.some((key) => Boolean(filters[key]));
}

function readPathReceiptId(pathname) {
  if (!pathname.startsWith(TRUST_RECEIPT_READ_PREFIX)) return null;
  const rawReceiptId = pathname.slice(TRUST_RECEIPT_READ_PREFIX.length);
  if (!rawReceiptId) return { ok: false, code: 'missing_receipt_id', receiptId: '' };
  try {
    const decoded = decodeURIComponent(rawReceiptId);
    const receiptId = sanitizeInput(decoded, TRUST_FILTER_MAX_ID);
    if (!receiptId) return { ok: false, code: 'invalid_receipt_id', receiptId: '' };
    return { ok: true, receiptId };
  } catch (_) {
    return { ok: false, code: 'invalid_receipt_id', receiptId: '' };
  }
}

module.exports = {
  TRUST_FILTER_MAX_ID,
  TRUST_FILTER_MAX_REF,
  TRUST_FILTER_MAX_ENUM,
  TRUST_RECEIPT_READ_PREFIX,
  readTrustFilters,
  hasTrustQuery,
  readPathReceiptId,
};
