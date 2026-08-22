const { describe, it } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const crypto = require('node:crypto');

const {
  checkRateLimit,
  clearExpiredRateLimitEntries,
  constantTimeEqual,
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

  it('readJsonBody decodes multi-byte UTF-8 split across chunk boundaries (#1023)', async () => {
    // `body += chunk` decoded each chunk on its own, so a character straddling
    // a chunk boundary became two U+FFFD replacements. JSON.parse still
    // succeeded — U+FFFD is valid inside a JSON string — so the body was
    // corrupted with no error code anywhere on the POST surface.
    const text = 'ğüşiöçĞÜŞİÖÇ'.repeat(2000);
    const payload = Buffer.from(JSON.stringify({ t: text }), 'utf8');

    const req = new EventEmitter();
    req.headers = { 'content-type': 'application/json' };
    req.destroy = () => {};

    const pending = readJsonBody(req, { maxBytes: 2_000_000 });
    // 1023 is deliberately coprime with the 2- and 3-byte character widths, so
    // boundaries land mid-character.
    for (let off = 0; off < payload.length; off += 1023) {
      req.emit('data', payload.subarray(off, Math.min(off + 1023, payload.length)));
    }
    req.emit('end');

    const result = await pending;
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.t, text);
    assert.strictEqual(result.data.t.length, text.length);
    assert.ok(!result.data.t.includes('\uFFFD'), 'body must not contain replacement characters');
  });

  it('readJsonBody bounds maxBytes by bytes, not by decoded characters (#1023)', async () => {
    // A 2-byte character must count as 2 against the limit; counting decoded
    // characters would let a Turkish body pass a byte budget it exceeds.
    const req = new EventEmitter();
    req.headers = { 'content-type': 'application/json' };
    req.destroy = () => {};

    const pending = readJsonBody(req, { maxBytes: 8 });
    req.emit('data', Buffer.from('ğüşiö', 'utf8')); // 10 bytes, 5 characters
    const result = await pending;

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 413);
  });

  it('streaming JSON overflow returns 413 without destroying the request (#713)', async () => {
    const req = new EventEmitter();
    req.headers = { 'content-type': 'application/json' };
    let destroyed = false;
    req.destroy = () => {
      destroyed = true;
    };

    const pending = readJsonBody(req, { maxBytes: 4 });
    req.emit('data', '1234');
    req.emit('data', '5');
    const result = await pending;

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 413);
    assert.strictEqual(result.error.error, 'Payload too large');
    assert.strictEqual(destroyed, false);
  });

  it('requireApiKey fails closed when configured key is missing, empty, or whitespace', () => {
    resetRateLimitState();
    // Hardened: error message MUST be the same generic 'Unauthorized' regardless
    // of whether the server has no key configured or the caller mismatched.
    // Leaking configuration state ('API key not configured') let attackers
    // enumerate deployment posture.
    const missing = requireApiKey({ headers: { authorization: 'Bearer anything' } }, '');
    assert.strictEqual(missing.ok, false);
    assert.strictEqual(missing.status, 401);
    assert.strictEqual(missing.headers['WWW-Authenticate'], 'Bearer');
    assert.strictEqual(missing.error.error, 'Unauthorized');

    const undefinedKey = requireApiKey({ headers: { 'x-api-key': 'anything' } }, undefined);
    assert.strictEqual(undefinedKey.ok, false);
    assert.strictEqual(undefinedKey.status, 401);
    assert.strictEqual(undefinedKey.error.error, 'Unauthorized');

    const whitespace = requireApiKey({ headers: { authorization: 'Bearer anything' } }, '   \t\n  ');
    assert.strictEqual(whitespace.ok, false);
    assert.strictEqual(whitespace.status, 401);
    assert.strictEqual(whitespace.error.error, 'Unauthorized');

    const mismatched = requireApiKey({ headers: { authorization: 'Bearer wrong' } }, 'secret');
    assert.strictEqual(mismatched.error.error, 'Unauthorized');
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

  it('many unique keys do not evict live entries or grow beyond the configured cap', () => {
    resetRateLimitState();
    const now = 1_000;
    const cap = 3;

    for (const key of ['k1', 'k2', 'k3']) {
      assert.strictEqual(checkRateLimit(key, now, 60_000, 2, cap), true);
      assert.ok(rateLimitMap.size <= cap);
    }

    for (const spoofedKey of ['k4', 'k5']) {
      assert.strictEqual(checkRateLimit(spoofedKey, now, 60_000, 2, cap), false);
      assert.ok(rateLimitMap.size <= cap);
    }

    assert.deepStrictEqual([...rateLimitMap.keys()].sort(), ['k1', 'k2', 'k3']);
    assert.strictEqual(checkRateLimit('k1', now + 1, 60_000, 2, cap), true);
    assert.strictEqual(checkRateLimit('k1', now + 2, 60_000, 2, cap), false);
  });

  it('missing identities fail closed without creating a shared unknown bucket', () => {
    resetRateLimitState();

    for (const missingIdentity of [undefined, null, '', 0, false]) {
      assert.strictEqual(checkRateLimit(missingIdentity, 1_000, 60_000, 2, 3), false);
    }

    assert.strictEqual(rateLimitMap.size, 0);
    assert.strictEqual(rateLimitMap.has('unknown'), false);
  });

  it('a zero entry cap rejects new identities without retaining state', () => {
    resetRateLimitState();

    assert.strictEqual(checkRateLimit('new-key', 1_000, 60_000, 2, 0), false);
    assert.strictEqual(rateLimitMap.size, 0);
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

  it('constantTimeEqual matches only on identical values', () => {
    assert.strictEqual(constantTimeEqual('secret', 'secret'), true);
    assert.strictEqual(constantTimeEqual('secret', 'secreT'), false);
    assert.strictEqual(constantTimeEqual('', ''), true);
    assert.strictEqual(constantTimeEqual(null, ''), true);
    assert.strictEqual(constantTimeEqual('secret', 'much-longer-secret-value'), false);
  });

  it('constantTimeEqual does not short-circuit on length mismatch', () => {
    // Regression for #384: a length check leaked the configured key length.
    const original = crypto.timingSafeEqual;
    let calls = 0;
    crypto.timingSafeEqual = (a, b) => {
      calls += 1;
      assert.strictEqual(a.length, b.length);
      return original(a, b);
    };
    try {
      assert.strictEqual(constantTimeEqual('a', 'a'.repeat(64)), false);
      assert.strictEqual(calls, 1, 'comparison must reach timingSafeEqual');
    } finally {
      crypto.timingSafeEqual = original;
    }
  });

  it('requireApiKey rejects wrong-length keys without leaking timing', () => {
    const res = requireApiKey({ headers: { authorization: 'Bearer x' } }, 'a-much-longer-configured-key');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 401);
  });
});
