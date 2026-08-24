'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createObservabilityHttpRouter } = require('../lib/observability/http-router');

function routeHarness(report) {
  const writes = [];
  const route = createObservabilityHttpRouter({
    getService: () => ({}),
    getHealth: () => ({ inspect: workspaceId => ({ ...report, workspaceId }) }),
    parseJsonRequest: async () => ({}),
    writeJson: (_req, _res, status, body) => writes.push({ status, body }),
    denyIfUnauthorized: () => true,
    authorizeWorkspace: () => ({ allowed: true }),
    rateLimiter: { check: () => ({ allowed: true }), acquireStream: () => ({ allowed: true, release() {} }) },
  });
  return { route, writes };
}

test('health stays live while readiness reports a dependency failure', async () => {
  const report = { liveness: { ok: true }, readiness: { ok: false }, database: { ok: false } };
  const health = routeHarness(report);
  await health.route({ method: 'GET' }, {}, new URL('http://local/api/observability/health?workspaceId=ws'));
  assert.equal(health.writes[0].status, 200);
  assert.equal(health.writes[0].body.ok, true);

  const ready = routeHarness(report);
  await ready.route({ method: 'GET' }, {}, new URL('http://local/api/observability/ready?workspaceId=ws'));
  assert.equal(ready.writes[0].status, 503);
  assert.equal(ready.writes[0].body.ok, false);
});

test('health routes require one exact workspace', async () => {
  const writes = [];
  const route = createObservabilityHttpRouter({
    getService: () => ({}),
    getHealth: () => ({ inspect: () => { throw new Error('must not inspect'); } }),
    parseJsonRequest: async () => ({}),
    writeJson: (_req, _res, status, body) => writes.push({ status, body }),
    denyIfUnauthorized: () => true,
    authorizeWorkspace: () => ({ allowed: true }),
    rateLimiter: { check: () => ({ allowed: true }), acquireStream: () => ({ allowed: true, release() {} }) },
  });
  await route({ method: 'GET' }, {}, new URL('http://local/api/observability/health'));
  assert.equal(writes[0].status, 400);
  assert.equal(writes[0].body.error.code, 'MISSING_WORKSPACE_ID');
});
