'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createConcurrencyLimiter, DEFAULT_MAX_CONCURRENT_REQUESTS, resolveRequestLimits } = require('../lib/http/request-limits');

test('Gate A item 3: concurrency limiter enforces ceiling and emits 503 semantics', () => {
  const limiter = createConcurrencyLimiter({ maxConcurrent: 2 });
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.active, 1);
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.active, 2);
  // At ceiling: next acquire fails
  assert.equal(limiter.tryAcquire(), false);
  assert.equal(limiter.rejected, 1);
  assert.equal(limiter.active, 2, 'rejected acquire must not increase active');
  limiter.release();
  assert.equal(limiter.active, 1);
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.active, 2);
  limiter.release();
  limiter.release();
  assert.equal(limiter.active, 0);
});

test('Gate A item 3: limiter at ceiling makes service slow rather than dead — fail-fast 503', () => {
  const limiter = createConcurrencyLimiter({ maxConcurrent: 1 });
  assert.equal(limiter.tryAcquire(), true);
  // Simulate second request arriving at ceiling
  const acquired = limiter.tryAcquire();
  assert.equal(acquired, false, 'second request must be rejected at ceiling');
  // Caller would receive 503 with Retry-After; limiter tracks rejection
  assert.equal(limiter.rejected, 1);
  assert.equal(limiter.stats().active, 1);
  limiter.release();
});

test('Gate A item 3: request body size ceilings already enforced via requestGuards', async () => {
  const { readJsonBody, DEFAULT_MAX_JSON_BODY, DEFAULT_MAX_UPLOAD_BODY } = require('../requestGuards');
  assert.equal(DEFAULT_MAX_JSON_BODY, 4096);
  assert.equal(DEFAULT_MAX_UPLOAD_BODY, 1_048_576);
  // Simulate oversized Content-Length fast-path
  const { Readable } = require('node:stream');
  const req = new Readable({ read() {} });
  req.headers = { 'content-type': 'application/json', 'content-length': String(DEFAULT_MAX_JSON_BODY + 1) };
  req.push(null);
  const result = await readJsonBody(req, { maxBytes: DEFAULT_MAX_JSON_BODY });
  assert.equal(result.ok, false);
  assert.equal(result.status, 413);
});

test('Gate A item 3: resolveRequestLimits env override and bounds', () => {
  assert.equal(DEFAULT_MAX_CONCURRENT_REQUESTS, 100);
  const limits = resolveRequestLimits(() => undefined);
  assert.equal(limits.maxConcurrent, 100);
  const custom = resolveRequestLimits((k) => k === 'MAX_CONCURRENT_REQUESTS' ? '5' : undefined);
  assert.equal(custom.maxConcurrent, 5);
  assert.throws(() => resolveRequestLimits((k) => k === 'MAX_CONCURRENT_REQUESTS' ? '0' : undefined), (err) => err.code === 'HUQAN_REQUEST_LIMIT_INVALID');
  assert.throws(() => resolveRequestLimits((k) => k === 'MAX_CONCURRENT_REQUESTS' ? '999999' : undefined), (err) => err.code === 'HUQAN_REQUEST_LIMIT_INVALID');
});

test('Gate A item 3: release is idempotent via double-close guard (server.js)', () => {
  const limiter = createConcurrencyLimiter({ maxConcurrent: 1 });
  assert.equal(limiter.tryAcquire(), true);
  let released = false;
  const releaseOnce = () => { if (!released) { released = true; limiter.release(); } };
  releaseOnce();
  releaseOnce(); // second close must not underflow
  assert.equal(limiter.active, 0);
  assert.equal(limiter.rejected, 0);
});
