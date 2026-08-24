'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createObservabilityAuthorizer } = require('../lib/observability/authorization');
const { createObservabilityHttpRouter } = require('../lib/observability/http-router');

const authorizer = createObservabilityAuthorizer({ policy: JSON.stringify({ memberships: [
  { subject: 'alice', workspaceId: 'ws-a', role: 'viewer' },
  { subject: 'operator', workspaceId: 'ws-a', role: 'operator' },
  { subject: 'admin', workspaceId: 'ws-a', role: 'admin' },
] }) });

function harness({ subject = 'alice', body = null } = {}) {
  const calls = [];
  let subscriber = null;
  const service = new Proxy({
    subscribe: listener => { subscriber = listener; return () => {}; },
  }, { get(target, key) {
    if (key in target) return target[key];
    return input => { calls.push({ key, input }); return key === 'deleteAlertRule' ? true : { items: [] }; };
  } });
  const writes = [];
  const router = createObservabilityHttpRouter({
    getService: () => service,
    getHealth: () => ({ inspect: () => ({ liveness: { ok: true }, readiness: { ok: true } }) }),
    parseJsonRequest: async () => body,
    writeJson: (_req, _res, status, response) => writes.push({ status, response }),
    denyIfUnauthorized: req => { req.huqanAuth = Object.freeze({ subject }); return true; },
    authorizeWorkspace: input => authorizer.authorize(input),
  });
  return { router, calls, writes, subscriber: () => subscriber };
}

test('every observability read and delete surface denies cross-workspace access before service use', async () => {
  for (const [method, suffix] of [
    ['GET', 'metrics'], ['GET', 'events'], ['GET', 'runs'], ['GET', 'queue'],
    ['GET', 'alerts'], ['GET', 'alert-rules'], ['DELETE', 'alert-rules/rule-1'],
  ]) {
    const h = harness({ subject: 'admin' });
    await h.router({ method, headers: {} }, {}, new URL(`http://local/api/observability/${suffix}?workspaceId=ws-b`));
    assert.equal(h.writes[0].status, 403, `${method} ${suffix}`);
    assert.equal(h.writes[0].response.error.code, 'OBSERVABILITY_WORKSPACE_FORBIDDEN');
    assert.deepEqual(h.calls, []);
  }
});

test('queue and alert mutations require exact body scope and sufficient role', async () => {
  const missing = harness({ subject: 'operator', body: { goal: 'safe' } });
  await missing.router({ method: 'POST', headers: {} }, {}, new URL('http://local/api/observability/queue'));
  assert.equal(missing.writes[0].status, 400);
  assert.deepEqual(missing.calls, []);

  const cross = harness({ subject: 'operator', body: { workspaceId: 'ws-b', goal: 'safe' } });
  await cross.router({ method: 'POST', headers: {} }, {}, new URL('http://local/api/observability/queue'));
  assert.equal(cross.writes[0].status, 403);
  assert.deepEqual(cross.calls, []);

  const role = harness({ subject: 'operator', body: { workspaceId: 'ws-a', metric: 'queue_depth' } });
  await role.router({ method: 'POST', headers: {} }, {}, new URL('http://local/api/observability/alert-rules'));
  assert.equal(role.writes[0].response.error.code, 'OBSERVABILITY_PERMISSION_FORBIDDEN');
  assert.deepEqual(role.calls, []);
});

test('SSE authorizes its workspace and never publishes another workspace event', async () => {
  const h = harness({ subject: 'alice' });
  const req = new EventEmitter(); req.method = 'GET'; req.headers = {};
  const chunks = [];
  const res = new EventEmitter();
  res.writableEnded = false;
  res.writeHead = status => { res.status = status; };
  res.write = chunk => chunks.push(chunk);
  await h.router(req, res, new URL('http://local/api/observability/stream?workspaceId=ws-a'));
  h.subscriber()({ workspaceId: 'ws-b', eventType: 'run_finished', eventId: 'secret-b' });
  h.subscriber()({ workspaceId: 'ws-a', eventType: 'run_finished', eventId: 'visible-a' });
  assert.equal(res.status, 200);
  assert.equal(chunks.join('').includes('secret-b'), false);
  assert.equal(chunks.join('').includes('visible-a'), true);
  req.emit('close');
});

test('unimplemented export, backup and notification surfaces remain closed', async () => {
  for (const suffix of ['export', 'backup', 'notifications']) {
    const h = harness({ subject: 'admin' });
    const handled = await h.router({ method: 'GET', headers: {} }, {},
      new URL(`http://local/api/observability/${suffix}?workspaceId=ws-a`));
    assert.equal(handled, false);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.writes, []);
  }
});
