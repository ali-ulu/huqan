'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createObservabilityRateLimiter } = require('../lib/observability/rate-limiter');
const { createObservabilityHttpRouter } = require('../lib/observability/http-router');

function policies({ read = 2, stream = 2, queue = 2, alerts = 2 } = {}) {
  return {
    read: { limit: read, windowMs: 1_000 },
    stream: { limit: stream, windowMs: 1_000, maxConcurrent: 1 },
    queue: { limit: queue, windowMs: 1_000 },
    alerts: { limit: alerts, windowMs: 1_000 },
  };
}

function harness({ limiter, subject = 'alice' } = {}) {
  const calls = [];
  const writes = [];
  const service = new Proxy({}, {
    get(_target, key) {
      if (key === 'subscribe') return () => () => {};
      return input => {
        calls.push({ key, input });
        return key === 'deleteAlertRule' ? true : { items: [] };
      };
    },
  });
  const router = createObservabilityHttpRouter({
    getService: () => service,
    getHealth: () => ({ inspect: () => ({ liveness: { ok: true }, readiness: { ok: true } }) }),
    parseJsonRequest: async () => ({ workspaceId: 'ws-a', goal: 'safe fixture' }),
    writeJson: (_req, _res, status, response, headers) => writes.push({ status, response, headers }),
    denyIfUnauthorized: req => {
      req.huqanAuth = Object.freeze({ subject: req.subject || subject });
      return true;
    },
    authorizeWorkspace: () => ({ allowed: true }),
    rateLimiter: limiter,
  });
  return { router, calls, writes };
}

function request({ method = 'GET', workspaceId = 'ws-a', subject = 'alice', suffix = 'events' } = {}) {
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false,
    writeHead(status) { this.status = status; },
    write() {},
  });
  return {
    req: Object.assign(new EventEmitter(), { method, headers: {}, subject }),
    res,
    url: new URL(`http://local/api/observability/${suffix}?workspaceId=${workspaceId}`),
  };
}

test('rate limiter enforces a bounded sliding window and releases stream concurrency', () => {
  let now = 10_000;
  const limiter = createObservabilityRateLimiter({ now: () => now, policies: policies({ read: 2 }) });

  assert.equal(limiter.acquire({ bucket: 'read', key: 'subject:alice' }).allowed, true);
  assert.equal(limiter.acquire({ bucket: 'read', key: 'subject:alice' }).allowed, true);
  const limited = limiter.acquire({ bucket: 'read', key: 'subject:alice' });
  assert.equal(limited.allowed, false);
  assert.equal(limited.reason, 'rate');
  assert.equal(limited.retryAfterSeconds, 1);

  now += 1_000;
  assert.equal(limiter.acquire({ bucket: 'read', key: 'subject:alice' }).allowed, true);

  const stream = limiter.acquire({ bucket: 'stream', key: 'subject:alice' });
  assert.equal(stream.allowed, true);
  const concurrent = limiter.acquire({ bucket: 'stream', key: 'subject:alice' });
  assert.equal(concurrent.allowed, false);
  assert.equal(concurrent.reason, 'concurrency');
  assert.equal(concurrent.retryAfterSeconds, 1);
  stream.release();
  assert.equal(limiter.acquire({ bucket: 'stream', key: 'subject:alice' }).allowed, true);
});

test('router returns stable 429 Retry-After and protects both subject and workspace buckets', async () => {
  const limiter = createObservabilityRateLimiter({ policies: policies({ read: 1 }) });
  const alice = harness({ limiter, subject: 'alice' });
  const first = request({ subject: 'alice', workspaceId: 'ws-a' });
  assert.equal(await alice.router(first.req, first.res, first.url), true);
  assert.equal(alice.writes[0].status, 200);

  const sameSubjectOtherWorkspace = request({ subject: 'alice', workspaceId: 'ws-b' });
  await alice.router(sameSubjectOtherWorkspace.req, sameSubjectOtherWorkspace.res, sameSubjectOtherWorkspace.url);
  assert.equal(alice.writes[1].status, 429);
  assert.equal(alice.writes[1].response.error.code, 'OBSERVABILITY_RATE_LIMITED');
  assert.match(alice.writes[1].headers['Retry-After'], /^[1-9]\d*$/);

  const differentSubjectSameWorkspace = request({ subject: 'bob', workspaceId: 'ws-a' });
  await alice.router(differentSubjectSameWorkspace.req, differentSubjectSameWorkspace.res, differentSubjectSameWorkspace.url);
  assert.equal(alice.writes[2].status, 429);

  const differentSubjectOtherWorkspace = request({ subject: 'bob', workspaceId: 'ws-b' });
  await alice.router(differentSubjectOtherWorkspace.req, differentSubjectOtherWorkspace.res, differentSubjectOtherWorkspace.url);
  assert.equal(alice.writes[3].status, 200);
  assert.equal(alice.calls.length, 2);
});

test('queue and alert-rule writes use their own bounded rate-limit buckets', async () => {
  for (const [method, suffix, bucket] of [
    ['POST', 'queue', 'queue'],
    ['POST', 'alert-rules', 'alerts'],
    ['DELETE', 'alert-rules/rule-1', 'alerts'],
  ]) {
    const limiter = createObservabilityRateLimiter({ policies: policies({ queue: 1, alerts: 1 }) });
    const h = harness({ limiter });
    const first = request({ method, suffix });
    await h.router(first.req, first.res, first.url);
    assert.notEqual(h.writes[0].status, 429, `${bucket} first request`);
    const second = request({ method, suffix });
    await h.router(second.req, second.res, second.url);
    assert.equal(h.writes[1].status, 429, `${bucket} second request`);
    assert.equal(h.calls.length, 1, `${bucket} service use after limit`);
  }
});

test('invalid query and unauthorized requests do not consume a rate-limit token', async () => {
  const limiter = createObservabilityRateLimiter({ policies: policies({ read: 1 }) });
  const h = harness({ limiter });
  const invalid = request();
  invalid.url = new URL('http://local/api/observability/events?workspaceId=ws-a&limit=101');
  await h.router(invalid.req, invalid.res, invalid.url);
  assert.equal(h.writes[0].status, 400);

  const valid = request();
  await h.router(valid.req, valid.res, valid.url);
  assert.equal(h.writes[1].status, 200);

  const exhausted = request();
  await h.router(exhausted.req, exhausted.res, exhausted.url);
  assert.equal(h.writes[2].status, 429);
});

test('SSE concurrency limit is released when the request closes', async () => {
  const limiter = createObservabilityRateLimiter({ policies: policies({ stream: 10 }) });
  const h = harness({ limiter });
  const first = request({ suffix: 'stream' });
  first.res.writableEnded = false;
  first.res.writeHead = status => { first.res.status = status; };
  first.res.write = () => {};
  await h.router(first.req, first.res, first.url);
  assert.equal(first.res.status, 200);

  const second = request({ suffix: 'stream' });
  await h.router(second.req, second.res, second.url);
  assert.equal(h.writes[0].status, 429);

  first.req.emit('close');
  const third = request({ suffix: 'stream' });
  third.res.writableEnded = false;
  third.res.writeHead = status => { third.res.status = status; };
  third.res.write = () => {};
  await h.router(third.req, third.res, third.url);
  assert.equal(third.res.status, 200);
  third.req.emit('close');
});
