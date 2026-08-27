'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createObservabilityHttpRouter } = require('../lib/observability/http-router');

function harness() {
  const calls = [];
  const writes = [];
  const service = new Proxy({}, {
    get(_target, key) {
      return input => {
        calls.push({ key, input });
        return key === 'deleteAlertRule' ? true : { items: [] };
      };
    },
  });
  const router = createObservabilityHttpRouter({
    getService: () => service,
    getHealth: () => ({ inspect: () => ({ liveness: { ok: true }, readiness: { ok: true } }) }),
    parseJsonRequest: async () => null,
    writeJson: (_req, _res, status, response) => writes.push({ status, response }),
    denyIfUnauthorized: req => {
      req.huqanAuth = Object.freeze({ subject: 'alice' });
      return true;
    },
    authorizeWorkspace: () => ({ allowed: true }),
  });
  return { router, calls, writes };
}

test('observability list and stream surfaces reject abusive query shapes before service use', async () => {
  const cases = [
    ['GET', '/events?workspaceId=ws-a&limit=101'],
    ['GET', '/runs?workspaceId=ws-a&limit=0'],
    ['GET', '/queue?workspaceId=ws-a&limit=1.5'],
    ['GET', '/alerts?workspaceId=ws-a&unknown=value'],
    ['GET', '/events?workspaceId=ws-a&status=queued&status=finished'],
    ['GET', `/events?workspaceId=ws-a&cursor=${'c'.repeat(513)}`],
    ['GET', `/events?workspaceId=ws-a&eventType=${'e'.repeat(2_050)}`],
    ['GET', '/stream?workspaceId=ws-a&limit=101'],
  ];

  for (const [method, path] of cases) {
    const h = harness();
    const handled = await h.router({ method, headers: {} }, {}, new URL(`http://local/api/observability${path}`));
    assert.equal(handled, true, `${method} ${path}`);
    assert.equal(h.writes[0]?.status, 400, `${method} ${path}`);
    assert.equal(h.writes[0]?.response.error.code, 'OBSERVABILITY_QUERY_INVALID', `${method} ${path}`);
    assert.deepEqual(h.calls, [], `${method} ${path}`);
  }
});

test('observability query guard preserves exact workspace validation and accepts the bounded limit', async () => {
  const duplicateWorkspace = harness();
  await duplicateWorkspace.router(
    { method: 'GET', headers: {} },
    {},
    new URL('http://local/api/observability/events?workspaceId=ws-a&workspaceId=ws-a'),
  );
  assert.equal(duplicateWorkspace.writes[0].status, 400);
  assert.equal(duplicateWorkspace.writes[0].response.error.code, 'INVALID_WORKSPACE_ID');
  assert.deepEqual(duplicateWorkspace.calls, []);

  const valid = harness();
  await valid.router(
    { method: 'GET', headers: {} },
    {},
    new URL('http://local/api/observability/events?workspaceId=ws-a&limit=100&cursor=cursor-1&eventType=run_finished&runId=run-1&status=completed&windowMs=60000'),
  );
  assert.equal(valid.writes[0].status, 200);
  assert.equal(valid.writes[0].response.ok, true);
  assert.equal(valid.calls.length, 1);
  assert.equal(valid.calls[0].key, 'listEvents');
  assert.deepEqual(valid.calls[0].input, {
    workspaceId: 'ws-a',
    limit: '100',
    cursor: 'cursor-1',
    eventType: 'run_finished',
    runId: 'run-1',
    status: 'completed',
    windowMs: '60000',
  });
});
