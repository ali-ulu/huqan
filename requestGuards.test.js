const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Readable } = require('node:stream');

const {
  checkRateLimit,
  readJsonBody,
  requireApiKey,
  sanitizeInput,
} = require('./requestGuards');

function makeReq(body, headers = {}) {
  const req = Readable.from([body]);
  req.headers = headers;
  return req;
}

function makeHeaderOnlyReq(headers = {}) {
  return {
    headers,
    on() {},
    destroy() {},
  };
}

describe('Request Guards', () => {
  it('sanitizeInput strips control chars and clamps length', () => {
    const input = `\u0000  kedi hayvandır  \u0007`;
    const output = sanitizeInput(input, 50);
    assert.strictEqual(output, 'kedi hayvandır');

    const longInput = 'a'.repeat(600);
    assert.strictEqual(sanitizeInput(longInput).length, 500);
  });

  it('checkRateLimit enforces a window and resets after expiry', () => {
    const ip = '127.0.0.1';
    const windowMs = 1_000;
    const maxRequests = 2;

    assert.strictEqual(checkRateLimit(ip, 0, windowMs, maxRequests), true);
    assert.strictEqual(checkRateLimit(ip, 10, windowMs, maxRequests), true);
    assert.strictEqual(checkRateLimit(ip, 20, windowMs, maxRequests), false);
    assert.strictEqual(checkRateLimit(ip, 1_500, windowMs, maxRequests), true);
  });

  it('requireApiKey and readJsonBody guard JSON endpoints', async () => {
    assert.strictEqual(requireApiKey({ headers: { authorization: 'Bearer secret-token' } }, 'secret-token').ok, true);
    assert.strictEqual(requireApiKey({ headers: { 'x-api-key': 'secret-token' } }, 'secret-token').ok, true);
    const denied = requireApiKey({ headers: {} }, 'secret-token');
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.status, 401);

    const parsed = await readJsonBody(makeReq('{"question":"kedi"}', {
      'content-type': 'application/json',
      'content-length': '19',
    }), { maxBytes: 100 });
    assert.strictEqual(parsed.ok, true);
    assert.deepStrictEqual(parsed.data, { question: 'kedi' });

    const unsupported = await readJsonBody(makeHeaderOnlyReq({
      'content-type': 'text/plain',
    }), { maxBytes: 100 });
    assert.strictEqual(unsupported.ok, false);
    assert.strictEqual(unsupported.status, 415);

    const oversized = await readJsonBody(makeHeaderOnlyReq({
      'content-type': 'application/json',
      'content-length': '999',
    }), { maxBytes: 100 });
    assert.strictEqual(oversized.ok, false);
    assert.strictEqual(oversized.status, 413);
  });
});
