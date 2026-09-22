'use strict';

// #2128: the viewer mount (rate limiter + session store + gateway) moved from
// server.js to lib/http/viewer-mount.js. This pins the moved behaviour:
// per-IP cap, window reset, entry eviction, gateway delegation, and reset.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createViewerMount,
  createViewerRateLimiter,
  VIEWER_RATE_LIMIT_WINDOW_MS,
  VIEWER_RATE_LIMIT_MAX,
  VIEWER_RATE_LIMIT_MAX_ENTRIES,
} = require('../lib/http/viewer-mount');

const reqFrom = (ip) => ({ socket: { remoteAddress: ip } });

test('#2128: limiter allows up to the cap then refuses within the window', () => {
  const limiter = createViewerRateLimiter({ max: 3, windowMs: 60_000 });
  const req = reqFrom('10.0.0.1');
  assert.equal(limiter.check(req, 1000), true);
  assert.equal(limiter.check(req, 1001), true);
  assert.equal(limiter.check(req, 1002), true);
  assert.equal(limiter.check(req, 1003), false);
  // Next window admits again.
  assert.equal(limiter.check(req, 61_001), true);
});

test('#2128: limiter isolates callers by IP and evicts expired entries', () => {
  const limiter = createViewerRateLimiter({ max: 1, windowMs: 1000, maxEntries: 2 });
  assert.equal(limiter.check(reqFrom('a'), 0), true);
  assert.equal(limiter.check(reqFrom('b'), 0), true);
  assert.equal(limiter.check(reqFrom('a'), 1), false);
  // Full table with no expired entry refuses the newcomer.
  assert.equal(limiter.check(reqFrom('c'), 1), false);
  // After expiry the table drains and the newcomer is admitted.
  assert.equal(limiter.check(reqFrom('c'), 1001), true);
});

test('#2128: limiter without a socket address still buckets', () => {
  const limiter = createViewerRateLimiter({ max: 1, windowMs: 60_000 });
  assert.equal(limiter.check({}, 0), true);
  assert.equal(limiter.check({}, 1), false);
});

test('#2128: reset clears all buckets', () => {
  const limiter = createViewerRateLimiter({ max: 1, windowMs: 60_000 });
  assert.equal(limiter.check(reqFrom('x'), 0), true);
  assert.equal(limiter.check(reqFrom('x'), 1), false);
  limiter.reset();
  assert.equal(limiter.check(reqFrom('x'), 2), true);
});

test('#2128: defaults match the values server.js used', () => {
  assert.equal(VIEWER_RATE_LIMIT_WINDOW_MS, 60_000);
  assert.equal(VIEWER_RATE_LIMIT_MAX, 120);
  assert.equal(VIEWER_RATE_LIMIT_MAX_ENTRIES, 2048);
});

test('#2128: mount delegates gateway paths and reset', async () => {
  const calls = [];
  const mount = createViewerMount({
    readReceipt: (...args) => { calls.push(args); return null; },
  });
  assert.equal(typeof mount.isViewerPath, 'function');
  assert.equal(typeof mount.handle, 'function');
  assert.equal(typeof mount.checkRateLimit, 'function');
  // A viewer path is recognised the way server.js routed it.
  assert.equal(mount.isViewerPath('/viewer/index.html'), true);
  assert.equal(mount.isViewerPath('/api/audit'), false);
  // Reset does not throw and re-admits a capped caller.
  const req = reqFrom('9.9.9.9');
  for (let i = 0; i < VIEWER_RATE_LIMIT_MAX; i++) mount.checkRateLimit(req, 0);
  assert.equal(mount.checkRateLimit(req, 1), false);
  mount.reset();
  assert.equal(mount.checkRateLimit(req, 2), true);
});

test('#2128: server.js routes viewer traffic through the mount', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(source.includes("require('./lib/http/viewer-mount')"), 'server requires the viewer mount');
  assert.ok(!source.includes("require('./lib/viewer/session-store')"), 'session-store require moved out');
  assert.ok(!source.includes("require('./lib/viewer/viewer-gateway')"), 'viewer-gateway require moved out');
  assert.ok(!source.includes('checkViewerRateLimit(req)'), 'inline rate check replaced by the mount');
});
