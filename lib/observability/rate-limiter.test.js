'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createObservabilityRateLimiter, parseRateLimitPolicy } = require('./rate-limiter');

const identity = { principal: { subject: 'alice' }, workspaceId: 'ws-a' };

test('rate windows are isolated by subject, workspace and action', () => {
  let timestamp = 1_000;
  const limiter = createObservabilityRateLimiter({
    now: () => timestamp,
    policy: JSON.stringify({ listRequests: 2, windowMs: 1_000 }),
  });
  assert.equal(limiter.check({ ...identity, action: 'listRequests' }).allowed, true);
  assert.equal(limiter.check({ ...identity, action: 'listRequests' }).allowed, true);
  const denied = limiter.check({ ...identity, action: 'listRequests' });
  assert.equal(denied.allowed, false);
  assert.equal(denied.code, 'OBSERVABILITY_RATE_LIMITED');
  assert.equal(denied.retryAfter, 1);
  assert.equal(limiter.check({ ...identity, workspaceId: 'ws-b', action: 'listRequests' }).allowed, true);
  assert.equal(limiter.check({ ...identity, principal: { subject: 'bob' }, action: 'listRequests' }).allowed, true);
  assert.equal(limiter.check({ ...identity, action: 'queueMutations' }).allowed, true);
  timestamp = 2_000;
  assert.equal(limiter.check({ ...identity, action: 'listRequests' }).allowed, true);
});

test('SSE connections have a concurrent subject/workspace cap and idempotent release', () => {
  const limiter = createObservabilityRateLimiter({ policy: JSON.stringify({ streamConnections: 1 }) });
  const first = limiter.acquireStream(identity);
  assert.equal(first.allowed, true);
  assert.equal(limiter.acquireStream(identity).code, 'OBSERVABILITY_STREAM_LIMITED');
  assert.equal(limiter.acquireStream({ ...identity, workspaceId: 'ws-b' }).allowed, true);
  first.release(); first.release();
  assert.equal(limiter.acquireStream(identity).allowed, true);
});

test('rate-limit policy rejects unknown, zero, negative and oversized values', () => {
  for (const policy of ['{', '[]', '{"unknown":1}', '{"listRequests":0}',
    '{"queueMutations":-1}', '{"windowMs":3600001}']) {
    assert.throws(() => parseRateLimitPolicy(policy), { code: 'OBSERVABILITY_RATE_LIMIT_POLICY_INVALID' });
  }
});
