'use strict';

const crypto = require('node:crypto');
const { constantTimeEqual: sharedConstantTimeEqual } = require('../../requestGuards');

function text(value) {
  return typeof value === 'string' ? value.trim() : String(value == null ? '' : value).trim();
}

// Fixed-length HMAC comparison only. Variable-length operator tokens use the
// shared hashing helper below so their length never reaches timingSafeEqual.
function constantTimeEqual(left, right) {
  const a = Buffer.from(text(left));
  const b = Buffer.from(text(right));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function operatorAuthorized(configuredToken, presentedToken) {
  if (!text(configuredToken) || !text(presentedToken)) return false;
  return sharedConstantTimeEqual(text(configuredToken), text(presentedToken));
}

function verifySignature(secret, rawBody, signature) {
  if (!text(secret) || !text(signature)) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  return constantTimeEqual(expected, signature);
}

function readRawBody(req, { maxBytes = 1_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    let overflowed = false;
    const chunks = [];
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      settle(value);
    };

    req.on('data', chunk => {
      if (overflowed) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      size += buf.length;
      if (size > maxBytes) {
        overflowed = true;
        chunks.length = 0;
        const error = new Error('Request body too large');
        error.code = 'REQUEST_TOO_LARGE';
        finish(reject, error);
        return;
      }
      chunks.push(buf);
    });

    req.on('end', () => finish(resolve, Buffer.concat(chunks)));
    req.on('error', error => finish(reject, error));
  });
}

function parseBody(rawBody) {
  try { return JSON.parse(rawBody.toString('utf8')); } catch (_) { return null; }
}

function writeNoStore(writeJson, req, res, status, payload, headers) {
  writeJson(req, res, status, payload, headers);
}

function getHeader(req, name) {
  const value = req?.headers?.[name];
  return typeof value === 'string' ? value : '';
}

module.exports = {
  text,
  operatorAuthorized,
  verifySignature,
  readRawBody,
  parseBody,
  writeNoStore,
  getHeader,
};
