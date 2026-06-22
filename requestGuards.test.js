const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Readable } = require('node:stream');

const {
  checkRateLimit,
  clearExpiredRateLimitEntries,
  isAllowedPublicCommand,
  isUnsafePublicApiCommand,
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
    const input = `\u0000  kedi hayvandÄ±r  \u0007`;
    const output = sanitizeInput(input, 50);
    assert.strictEqual(output, 'kedi hayvandÄ±r');

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

  it('requireApiKey fails closed when configured key is missing, empty, or whitespace', () => {
    const missing = requireApiKey({ headers: { authorization: 'Bearer anything' } }, '');
    assert.strictEqual(missing.ok, false);
    assert.strictEqual(missing.status, 401);
    assert.strictEqual(missing.headers['WWW-Authenticate'], 'Bearer');
    assert.strictEqual(missing.error.error, 'API key not configured');

    const undefinedKey = requireApiKey({ headers: { 'x-api-key': 'anything' } }, undefined);
    assert.strictEqual(undefinedKey.ok, false);
    assert.strictEqual(undefinedKey.status, 401);
    assert.strictEqual(undefinedKey.error.error, 'API key not configured');

    const whitespace = requireApiKey({ headers: { authorization: 'Bearer anything' } }, '   \t\n  ');
    assert.strictEqual(whitespace.ok, false);
    assert.strictEqual(whitespace.status, 401);
    assert.strictEqual(whitespace.error.error, 'API key not configured');
  });

  it('isUnsafePublicApiCommand blocks public mutating command variants', () => {
    const blocked = [
      'restore:foo',
      'restore foo',
      'yukle:README.md',
      'yüKle README.md',
      'load:README.md',
      'delete:foo',
      'remove:foo',
      'tombstone:foo',
      'supersede:foo',
      'link:foo',
      'backup now',
      'export:README.md',
      'kaydet',
      'learn:foo',
      'öğret:foo',
      'company-ingest:README.md',
      'company ingest README.md',
      'öğren --kaynak markdown --yol README.md',
      'import:README.md',
    ];

    for (const input of blocked) {
      assert.strictEqual(isUnsafePublicApiCommand(input), true, `Expected blocked: ${input}`);
    }

    assert.strictEqual(isUnsafePublicApiCommand('merhaba'), false);
    assert.strictEqual(isUnsafePublicApiCommand('kedi nedir'), false);
  });

  it('isAllowedPublicCommand only permits explicit read-only public commands', () => {
    const allowed = [
      'selam',
      'yardim',
      'yardım',
      'durum',
      'sor',
      'neden',
      'karsilastir',
      'karşılaştır',
      'anlamadim',
      'anlamadım',
    ];
    for (const input of allowed) {
      assert.strictEqual(isAllowedPublicCommand(input), true, `Expected allowed: ${input}`);
    }

    const blocked = [
      '',
      'öğret',
      'yukle',
      'restore',
      'plan',
      'ajan',
      'llm-sor',
      'company-query',
      'bilinmeyen-komut',
    ];
    for (const input of blocked) {
      assert.strictEqual(isAllowedPublicCommand(input), false, `Expected blocked: ${input}`);
    }
  });

  // â”€â”€ PR-S1 GUV-2: rate-limit pruning behavior â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  it('PR-S1 GUV-2: clearExpiredRateLimitEntries prunes expired entries and resets window', () => {
    const key = 'guv2-test-' + Math.random().toString(36).slice(2, 9);
    const windowMs = 1_000;
    const max = 5;

    checkRateLimit(key, 0, windowMs, max);
    checkRateLimit(key, 100, windowMs, max);
    checkRateLimit(key, 500, windowMs, max);

    assert.doesNotThrow(() => clearExpiredRateLimitEntries(1_500));

    const allowedAfter = checkRateLimit(key, 1_600, windowMs, max);
    assert.strictEqual(allowedAfter, true);
  });

  it('PR-S1 GUV-2: clearExpiredRateLimitEntries is callable and does not throw on empty map', () => {
    assert.doesNotThrow(() => clearExpiredRateLimitEntries(Date.now() + 60_000));
    assert.doesNotThrow(() => clearExpiredRateLimitEntries(0));
  });
});
