'use strict';

const { constantTimeEqual } = require('../../requestGuards');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const VIEWER_PREFIX = '/viewer';
const SESSION_PATH = '/viewer/session';
const RECEIPT_PREFIX = '/viewer/api/trust-receipt/';
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const MAX_LOGIN_BODY_BYTES = 1024;
const MAX_RECEIPT_ID_LENGTH = 128;
const STATIC_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
});
const HTML_CSP = "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'";
const ASSET_ROOT = path.join(__dirname, '..', '..', 'public', 'viewer');
const STATIC_ASSETS = new Map([
  [VIEWER_PREFIX, {
    body: readFileSync(path.join(ASSET_ROOT, 'index.html'), 'utf8'),
    contentType: 'text/html; charset=utf-8',
    headers: { 'Content-Security-Policy': HTML_CSP },
  }],
  [`${VIEWER_PREFIX}/app.mjs`, {
    body: readFileSync(path.join(ASSET_ROOT, 'app.mjs'), 'utf8'),
    contentType: 'text/javascript; charset=utf-8',
  }],
  [`${VIEWER_PREFIX}/receipt-view-model.mjs`, {
    body: readFileSync(path.join(ASSET_ROOT, 'receipt-view-model.mjs'), 'utf8'),
    contentType: 'text/javascript; charset=utf-8',
  }],
  [`${VIEWER_PREFIX}/viewer.css`, {
    body: readFileSync(path.join(ASSET_ROOT, 'viewer.css'), 'utf8'),
    contentType: 'text/css; charset=utf-8',
  }],
]);

function isViewerPath(pathname) {
  return pathname === VIEWER_PREFIX || pathname.startsWith(`${VIEWER_PREFIX}/`);
}

function writeJson(res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, {
    'Content-Type': JSON_CONTENT_TYPE,
    'Cache-Control': 'no-store',
    Vary: 'Cookie',
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

function writeEmpty(res, statusCode, headers = {}) {
  res.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    Vary: 'Cookie',
    ...headers,
  });
  res.end();
}

function writeAsset(res, asset) {
  res.writeHead(200, {
    ...STATIC_HEADERS,
    'Content-Type': asset.contentType,
    ...(asset.headers || {}),
  });
  res.end(asset.body);
}

function fail(res, statusCode, code, message, headers = {}) {
  writeJson(res, statusCode, { ok: false, error: { code, message } }, headers);
}

function secureEqual(left, right) {
  return constantTimeEqual(left, right);
}

function isLoopbackAddress(address) {
  const value = String(address || '').toLowerCase();
  return value === '::1'
    || value.startsWith('127.')
    || value.startsWith('::ffff:127.');
}

function isLoopbackHost(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader.includes('/') || hostHeader.includes('\\')) {
    return false;
  }
  try {
    const hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

function useInsecureLoopback(req, enabled) {
  return enabled
    && isLoopbackAddress(req.socket?.localAddress)
    && isLoopbackHost(req.headers?.host);
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_LOGIN_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        resolve({ ok: false, status: 413, code: 'payload_too_large', message: 'Request body is too large' });
        return;
      }
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve({ ok: true, value });
      } catch {
        resolve({ ok: false, status: 400, code: 'invalid_json', message: 'Request body must be valid JSON' });
      }
    });
    req.on('error', () => {
      resolve({ ok: false, status: 400, code: 'invalid_request', message: 'Request body could not be read' });
    });
  });
}

function readReceiptId(pathname) {
  if (!pathname.startsWith(RECEIPT_PREFIX)) return null;
  const raw = pathname.slice(RECEIPT_PREFIX.length);
  if (!raw) return { ok: false };
  try {
    const receiptId = decodeURIComponent(raw).trim();
    // oxlint-disable-next-line no-control-regex -- deliberate: rejects control characters in a receipt id
    if (!receiptId || receiptId.length > MAX_RECEIPT_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(receiptId)) {
      return { ok: false };
    }
    return { ok: true, receiptId };
  } catch {
    return { ok: false };
  }
}

module.exports = {
  VIEWER_PREFIX,
  SESSION_PATH,
  RECEIPT_PREFIX,
  MAX_RECEIPT_ID_LENGTH,
  STATIC_ASSETS,
  isViewerPath,
  writeJson,
  writeEmpty,
  writeAsset,
  fail,
  secureEqual,
  useInsecureLoopback,
  readJsonBody,
  readReceiptId,
};
