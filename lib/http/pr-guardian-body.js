'use strict';

const NO_STORE = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});

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
      // Real HTTP requests emit Buffers; in-process callers and tests emit
      // strings. Normalizing keeps `size` a byte count in both cases, which is
      // what maxBytes claims to bound.
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      size += buf.length;
      if (size > maxBytes) {
        // Stop buffering, but do NOT destroy the request (#749).
        //
        // req.destroy() closed the socket before the route could write the 413
        // this function had just promised it, so the client saw ECONNRESET
        // instead of the policy answer. requestGuards.readJsonBody fixed
        // exactly this and returns a clean 413; the webhook reader kept the old
        // behaviour, so the same limit was enforced differently depending on
        // which door the request came through. A caller cannot tell a policy
        // rejection from a transport failure, and retries on the latter
        // amplify load.
        //
        // Releasing the buffer is what actually bounds memory here; the
        // remaining inbound bytes are ignored and the route writes its response
        // and closes the connection normally.
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
    // A late error after an overflow -- the peer giving up once we stop
    // reading, for instance -- must not turn the settled 413 into a 400.
    req.on('error', error => finish(reject, error));
  });
}

function parseBody(rawBody) {
  try { return JSON.parse(rawBody.toString('utf8')); } catch (_) { return null; }
}

function write(writeJson, req, res, status, payload) {
  writeJson(req, res, status, payload, NO_STORE);
}

function getHeader(req, name) {
  const value = req?.headers?.[name];
  return typeof value === 'string' ? value : '';
}

module.exports = Object.freeze({
  NO_STORE,
  readRawBody,
  parseBody,
  write,
  getHeader,
});
