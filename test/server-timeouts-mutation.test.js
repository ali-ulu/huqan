'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_HTTP_TIMEOUTS,
  DEFAULT_MAX_CONCURRENT_REQUESTS,
  DEFAULT_RETRY_AFTER_MS,
  resolveHttpServerTimeouts,
  resolveRequestLimits,
  createConcurrencyLimiter,
} = require('../lib/http/server-timeouts');

const reader = (values = {}) => (name) => values[name];


test('HTTP timeout and request-limit defaults are independently pinned', () => {
  assert.deepEqual(DEFAULT_HTTP_TIMEOUTS, {
    headersTimeout: 10000,
    requestTimeout: 30000,
    keepAliveTimeout: 5000,
    connectionsCheckingInterval: 1000,
  });
  assert.equal(DEFAULT_MAX_CONCURRENT_REQUESTS, 100);
  assert.equal(DEFAULT_RETRY_AFTER_MS, 1000);
});

test('timeout resolver accepts every documented inclusive boundary', () => {
  assert.deepEqual(resolveHttpServerTimeouts(reader({
    HEADERS_TIMEOUT_MS: '1000',
    REQUEST_TIMEOUT_MS: '1000',
    KEEP_ALIVE_TIMEOUT_MS: '100',
  })), {
    headersTimeout: 1000,
    requestTimeout: 1000,
    keepAliveTimeout: 100,
    connectionsCheckingInterval: 1000,
  });

  assert.deepEqual(resolveHttpServerTimeouts(reader({
    HEADERS_TIMEOUT_MS: '120000',
    REQUEST_TIMEOUT_MS: '300000',
    KEEP_ALIVE_TIMEOUT_MS: '60000',
  })), {
    headersTimeout: 120000,
    requestTimeout: 300000,
    keepAliveTimeout: 60000,
    connectionsCheckingInterval: 1000,
  });
});

test('timeout resolver rejects every out-of-range and non-integer boundary', () => {
  const cases = [
    ['HEADERS_TIMEOUT_MS', '999'],
    ['HEADERS_TIMEOUT_MS', '120001'],
    ['HEADERS_TIMEOUT_MS', '1000.5'],
    ['REQUEST_TIMEOUT_MS', '999'],
    ['REQUEST_TIMEOUT_MS', '300001'],
    ['REQUEST_TIMEOUT_MS', '1000.5'],
    ['KEEP_ALIVE_TIMEOUT_MS', '99'],
    ['KEEP_ALIVE_TIMEOUT_MS', '60001'],
    ['KEEP_ALIVE_TIMEOUT_MS', '100.5'],
  ];
  for (const [name, value] of cases) {
    assert.throws(() => resolveHttpServerTimeouts(reader({ [name]: value })), (error) => {
      assert.equal(error.code, 'HUQAN_HTTP_TIMEOUT_INVALID');
      assert.equal(error.field, name);
      assert.match(error.message, new RegExp(name));
      assert.match(error.message, /expected an integer between/);
      return true;
    });
  }
  assert.throws(() => resolveHttpServerTimeouts(null), /readEnvironment must be a function/);
});

test('request limit resolver pins defaults, coercion and inclusive bounds', () => {
  for (const raw of [undefined, null, '']) {
    assert.deepEqual(resolveRequestLimits(reader({ MAX_CONCURRENT_REQUESTS: raw })), {
      maxConcurrent: DEFAULT_MAX_CONCURRENT_REQUESTS,
      retryAfterMs: DEFAULT_RETRY_AFTER_MS,
    });
  }
  assert.deepEqual(resolveRequestLimits(reader({ MAX_CONCURRENT_REQUESTS: '1' })), {
    maxConcurrent: 1,
    retryAfterMs: 1000,
  });
  assert.deepEqual(resolveRequestLimits(reader({ MAX_CONCURRENT_REQUESTS: '10000' })), {
    maxConcurrent: 10000,
    retryAfterMs: 1000,
  });
  for (const value of ['0', '10001', '1.5', 'nope']) {
    assert.throws(() => resolveRequestLimits(reader({ MAX_CONCURRENT_REQUESTS: value })), (error) => {
      assert.equal(error.code, 'HUQAN_REQUEST_LIMIT_INVALID');
      assert.equal(error.field, 'MAX_CONCURRENT_REQUESTS');
      assert.match(error.message, /expected integer between 1 and 10000/);
      return true;
    });
  }
  assert.throws(() => resolveRequestLimits({}), /readEnvironment must be a function/);
});

test('concurrency limiter has exact acquire, reject, release and stats semantics', () => {
  for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createConcurrencyLimiter({ maxConcurrent: bad }), /positive integer/);
  }

  const limiter = createConcurrencyLimiter({ maxConcurrent: 2 });
  assert.equal(Object.isFrozen(limiter), true);
  assert.deepEqual(limiter.stats(), { active: 0, rejected: 0, maxConcurrent: 2 });
  assert.equal(Object.isFrozen(limiter.stats()), true);
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.active, 1);
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.active, 2);
  assert.equal(limiter.tryAcquire(), false);
  assert.equal(limiter.rejected, 1);
  assert.equal(limiter.tryAcquire(), false);
  assert.equal(limiter.rejected, 2);
  limiter.release();
  assert.equal(limiter.active, 1);
  limiter.release();
  assert.equal(limiter.active, 0);
  limiter.release();
  assert.equal(limiter.active, 0);
  assert.deepEqual(limiter.stats(), { active: 0, rejected: 2, maxConcurrent: 2 });
});
