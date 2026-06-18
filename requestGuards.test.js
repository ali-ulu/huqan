const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Readable } = require('node:stream');

const {
  checkRateLimit,
  clearExpiredRateLimitEntries,
  DEFAULT_RATE_LIMIT_MAX_ENTRIES,
  enforceRateLimitCap,
  isAllowedPublicCommand,
  isUnsafePublicApiCommand,
  readJsonBody,
  rateLimitMap,
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

function resetRateLimitState() {
  rateLimitMap.clear();
}

describe('Request Guards', () => {
  it('sanitizeInput strips control chars and clamps length', () => {
    resetRateLimitState();
    const input = `\u0000  kedi hayvandir  \u0007`;
    const output = sanitizeInput(input, 50);
    assert.strictEqual(output, 'kedi hayvandir');

    const longInput = 'a'.repeat(600);
    assert.strictEqual(sanitizeInput(longInput).length, 500);
  });

  it('checkRateLimit enforces a window and resets after expiry', () => {
    resetRateLimitState();
    const ip = '127.0.0.1';
    const windowMs = 1_000;
    const maxRequests = 2;

    assert.strictEqual(checkRateLimit(ip, 0, windowMs, maxRequests), true);
    assert.strictEqual(checkRateLimit(ip, 10, windowMs, maxRequests), true);
    assert.strictEqual(checkRateLimit(ip, 20, windowMs, maxRequests), false);
    assert.strictEqual(checkRateLimit(ip, 1_500, windowMs, maxRequests), true);
  });

  it('requireApiKey and readJsonBody guard JSON endpoints', async () => {
    resetRateLimitState();
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
    resetRateLimitState();
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
    resetRateLimitState();
    const blocked = [
      'restore:foo',
      'restore foo',
      'yukle:README.md',
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
      'ogret:foo',
      'company-ingest:README.md',
      'company ingest README.md',
      'ogren --kaynak markdown --yol README.md',
      'import:README.md',
      'dusunmeye basla',
      'surekli dusun',
      'dusun:derin',
      'optimize',
      'optimize:graph',
      'konsolide',
      'evolve',
      'ajan:plan-yap',
      'plan',
    ];

    for (const input of blocked) {
      assert.strictEqual(isUnsafePublicApiCommand(input), true, `Expected blocked: ${input}`);
    }

    assert.strictEqual(isUnsafePublicApiCommand('merhaba'), false);
    assert.strictEqual(isUnsafePublicApiCommand('kedi nedir'), false);
  });

  it('isAllowedPublicCommand accepts whitelisted read-only commands', () => {
    resetRateLimitState();
    const allowed = [
      'selam',
      'yardim',
      'sor',
      'durum',
      'anlamadim',
    ];
    for (const c of allowed) {
      assert.strictEqual(isAllowedPublicCommand(c), true, `Expected allowed: ${c}`);
    }
  });

  it('isAllowedPublicCommand rejects mutating/agent/background/list commands', () => {
    resetRateLimitState();
    const blocked = [
      'ogren', 'learn',
      'restore', 'yukle', 'load', 'import', 'ingest',
      'backup', 'export', 'kaydet', 'delete', 'remove',
      'dusun', 'autothink',
      'dusunmeye basla', 'surekli dusun',
      'optimize', 'konsolide', 'evolve', 'ajan', 'plan',
      'listele', 'kimler', 'neler',
    ];
    for (const c of blocked) {
      assert.strictEqual(isAllowedPublicCommand(c), false, `Expected rejected: ${c}`);
    }
  });

  it('isAllowedPublicCommand rejects non-string or empty input', () => {
    resetRateLimitState();
    assert.strictEqual(isAllowedPublicCommand(null), false);
    assert.strictEqual(isAllowedPublicCommand(undefined), false);
    assert.strictEqual(isAllowedPublicCommand(''), false);
    assert.strictEqual(isAllowedPublicCommand(123), false);
    assert.strictEqual(isAllowedPublicCommand('   '), false);
  });

  it('isAllowedPublicCommand respects injected allowlist set', () => {
    resetRateLimitState();
    const customSet = new Set(['foo', 'bar']);
    assert.strictEqual(isAllowedPublicCommand('foo', customSet), true);
    assert.strictEqual(isAllowedPublicCommand('selam', customSet), false);
  });

  it('clearExpiredRateLimitEntries prunes expired entries and resets window', () => {
    resetRateLimitState();
    const key = 'guv2-test-key';
    const windowMs = 1_000;
    const max = 5;

    checkRateLimit(key, 0, windowMs, max);
    checkRateLimit(key, 100, windowMs, max);
    checkRateLimit(key, 500, windowMs, max);

    assert.doesNotThrow(() => clearExpiredRateLimitEntries(1_500));

    const allowedAfter = checkRateLimit(key, 1_600, windowMs, max);
    assert.strictEqual(allowedAfter, true);
  });

  it('clearExpiredRateLimitEntries is callable and does not throw on empty map', () => {
    resetRateLimitState();
    assert.doesNotThrow(() => clearExpiredRateLimitEntries(Date.now() + 60_000));
    assert.doesNotThrow(() => clearExpiredRateLimitEntries(0));
  });

  it('many unique keys do not grow the map beyond the configured cap', () => {
    resetRateLimitState();
    const now = 1_000;
    const cap = 3;

    for (const key of ['k1', 'k2', 'k3', 'k4', 'k5']) {
      assert.strictEqual(checkRateLimit(key, now, 60_000, 2, cap), true);
      assert.ok(rateLimitMap.size <= cap);
    }

    assert.deepStrictEqual([...rateLimitMap.keys()].sort(), ['k3', 'k4', 'k5']);
  });

  it('expired entries are removed before cap eviction', () => {
    resetRateLimitState();
    checkRateLimit('expired-a', 0, 100, 2, 3);
    checkRateLimit('expired-b', 0, 100, 2, 3);
    checkRateLimit('live-c', 150, 1_000, 2, 3);

    assert.strictEqual(checkRateLimit('fresh-d', 200, 1_000, 2, 3), true);
    assert.deepStrictEqual([...rateLimitMap.keys()].sort(), ['fresh-d', 'live-c']);
  });

  it('cap eviction is deterministic and does not throw', () => {
    resetRateLimitState();
    rateLimitMap.set('z-key', { count: 1, resetAt: 500 });
    rateLimitMap.set('a-key', { count: 1, resetAt: 500 });
    rateLimitMap.set('b-key', { count: 3, resetAt: 700 });

    assert.doesNotThrow(() => enforceRateLimitCap(100, 2));
    assert.strictEqual(rateLimitMap.size, 2);
    assert.strictEqual(rateLimitMap.has('a-key'), false);
    assert.strictEqual(rateLimitMap.has('z-key'), true);
    assert.strictEqual(rateLimitMap.has('b-key'), true);
  });

  it('default cap constant stays positive', () => {
    resetRateLimitState();
    assert.ok(DEFAULT_RATE_LIMIT_MAX_ENTRIES >= 1);
  });
});
