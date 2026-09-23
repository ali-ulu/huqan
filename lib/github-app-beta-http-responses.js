'use strict';

// #2231: HTTP response primitives extracted from github-app-beta-http-boundary.
// One job: frozen JSON response descriptors, header access, bounded raw-body
// reads. No webhook semantics, no store access, no config.

const { MAX_WEBHOOK_BYTES } = require('./github-app-beta-handler');

const JSON_HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});

function descriptor(statusCode, body, extraHeaders = {}) {
  return Object.freeze({
    statusCode,
    headers: Object.freeze({ ...JSON_HEADERS, ...extraHeaders }),
    body: Object.freeze(body),
  });
}

function requestHeaders(req) {
  const distinct = req && req.headersDistinct;
  if (distinct && typeof distinct === 'object' && !Array.isArray(distinct)) return distinct;
  const headers = req && req.headers;
  return headers && typeof headers === 'object' && !Array.isArray(headers) ? headers : {};
}

function singleHeader(headers, name) {
  const value = headers[String(name).toLowerCase()];
  if (Array.isArray(value)) return value.length === 1 && typeof value[0] === 'string' ? value[0] : '';
  return typeof value === 'string' ? value : '';
}

async function readRawBody(req, maxBytes = MAX_WEBHOOK_BYTES) {
  const declared = Number(req?.headers?.['content-length'] || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, status: 413 };
  }

  return new Promise((resolve) => {
    let settled = false;
    let size = 0;
    const chunks = [];
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    req.on('data', (chunk) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) {
        finish({ ok: false, status: 413 });
        return;
      }
      chunks.push(bytes);
    });
    req.on('end', () => finish({ ok: true, body: Buffer.concat(chunks, size) }));
    req.on('aborted', () => finish({ ok: false, status: 400 }));
    req.on('error', () => finish({ ok: false, status: 400 }));
  });
}

module.exports = Object.freeze({
  JSON_HEADERS,
  descriptor,
  requestHeaders,
  singleHeader,
  readRawBody,
});
