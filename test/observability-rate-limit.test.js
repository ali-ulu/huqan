'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createObservabilityHttpRouter } = require('../lib/observability/http-router');
const { createObservabilityRateLimiter } = require('../lib/observability/rate-limiter');

function harness({ subject = 'alice', body = null, policy = {}, limiter } = {}) {
  const calls = [];
  const service = new Proxy({ subscribe: () => () => {} }, { get(target, key) {
    if (key in target) return target[key];
    return input => { calls.push({ key, input }); return { items: [] }; };
  } });
  const writes = [];
  const rateLimiter = limiter || createObservabilityRateLimiter({ policy: JSON.stringify(policy) });
  const router = createObservabilityHttpRouter({
    getService: () => service,
    getHealth: () => ({ inspect: () => ({ liveness: { ok: true }, readiness: { ok: true } }) }),
    parseJsonRequest: async () => body,
    writeJson: (_req, _res, status, response, headers) => writes.push({ status, response, headers }),
    denyIfUnauthorized: req => { req.huqanAuth = { subject }; return true; },
    authorizeWorkspace: () => ({ allowed: true }),
    rateLimiter,
  });
  return { router, calls, writes };
}

test('list and mutation limits return a stable 429 contract before service use', async () => {
  const h = harness({ policy: { listRequests: 1, queueMutations: 1 }, body: { workspaceId: 'ws-a', goal: 'safe' } });
  const get = () => h.router({ method: 'GET', headers: {} }, {}, new URL('http://local/api/observability/events?workspaceId=ws-a&limit=10'));
  await get(); await get();
  assert.equal(h.writes[1].status, 429);
  assert.equal(h.writes[1].response.error.code, 'OBSERVABILITY_RATE_LIMITED');
  assert.match(h.writes[1].headers['Retry-After'], /^\d+$/);
  assert.equal(h.calls.length, 1);

  const post = () => h.router({ method: 'POST', headers: {} }, {}, new URL('http://local/api/observability/queue'));
  await post(); await post();
  assert.equal(h.writes[3].status, 429);
  assert.equal(h.calls.length, 2);
});

test('oversized and abusive pagination queries are rejected consistently', async () => {
  for (const query of [
    'workspaceId=ws-a&limit=101',
    'workspaceId=ws-a&limit=1&limit=2',
    `workspaceId=ws-a&cursor=${'x'.repeat(513)}`,
    `workspaceId=ws-a&cursor=${'x'.repeat(2050)}`,
    'workspaceId=ws-a&unexpected=1',
  ]) {
    const h = harness();
    await h.router({ method: 'GET', headers: {} }, {}, new URL(`http://local/api/observability/events?${query}`));
    assert.equal(h.writes[0].status, 400, query);
    assert.equal(h.writes[0].response.error.code, 'OBSERVABILITY_QUERY_INVALID');
    assert.deepEqual(h.calls, []);
  }
});

test('SSE reconnect storms and concurrent connections are bounded and released', async () => {
  const limiter = createObservabilityRateLimiter({ policy: JSON.stringify({ streamAttempts: 2, streamConnections: 1 }) });
  const first = harness({ limiter });
  const req = new EventEmitter(); req.method = 'GET'; req.headers = {};
  const res = new EventEmitter(); res.writableEnded = false; res.writeHead = () => {}; res.write = () => {};
  await first.router(req, res, new URL('http://local/api/observability/stream?workspaceId=ws-a'));

  const concurrent = harness({ limiter });
  await concurrent.router({ method: 'GET', headers: {} }, {}, new URL('http://local/api/observability/stream?workspaceId=ws-a'));
  assert.equal(concurrent.writes[0].status, 429);
  assert.equal(concurrent.writes[0].response.error.code, 'OBSERVABILITY_STREAM_LIMITED');
  req.emit('close');

  const storm = harness({ limiter });
  await storm.router({ method: 'GET', headers: {} }, {}, new URL('http://local/api/observability/stream?workspaceId=ws-a'));
  assert.equal(storm.writes[0].response.error.code, 'OBSERVABILITY_RATE_LIMITED');
});

test('unavailable limiter fails closed without leaking configuration errors', async () => {
  const limiter = { check() { throw new Error('secret config'); }, acquireStream() { throw new Error('secret config'); } };
  const h = harness({ limiter });
  await h.router({ method: 'GET', headers: {} }, {}, new URL('http://local/api/observability/events?workspaceId=ws-a'));
  assert.equal(h.writes[0].status, 503);
  assert.equal(h.writes[0].response.error.code, 'OBSERVABILITY_RATE_LIMIT_UNAVAILABLE');
  assert.equal(JSON.stringify(h.writes[0]).includes('secret config'), false);
});
