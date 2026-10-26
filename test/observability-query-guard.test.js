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

test('a custom date range reaches the list and metrics queries as numbers (#4296)', async () => {
  const events = harness();
  await events.router(
    { method: 'GET', headers: {} },
    {},
    new URL('http://local/api/observability/events?workspaceId=ws-a&startMs=1000&endMs=2000'),
  );
  assert.equal(events.writes[0].status, 200);
  assert.equal(events.calls[0].input.startMs, 1000);
  assert.equal(events.calls[0].input.endMs, 2000);

  const metrics = harness();
  await metrics.router(
    { method: 'GET', headers: {} },
    {},
    new URL('http://local/api/observability/metrics?workspaceId=ws-a&startMs=1000&endMs=2000'),
  );
  assert.equal(metrics.writes[0].status, 200);
  const summary = metrics.calls.find(call => call.key === 'summary');
  assert.equal(summary.input.startMs, 1000);
  assert.equal(summary.input.endMs, 2000);
});

test('a malformed custom date range is rejected before the service runs (#4296)', async () => {
  const cases = [
    '/events?workspaceId=ws-a&startMs=2000&endMs=1000', // start after end
    '/events?workspaceId=ws-a&startMs=1000', // end missing
    '/runs?workspaceId=ws-a&endMs=1000', // start missing
    '/metrics?workspaceId=ws-a&startMs=abc&endMs=2000',
    '/metrics?workspaceId=ws-a&startMs=-1&endMs=2000',
    '/runs?workspaceId=ws-a&startMs=1000.5&endMs=2000',
    '/runs?workspaceId=ws-a&startMs=1000&endMs=1234567890123456', // beyond 15 digits
    '/events?workspaceId=ws-a&startMs=&endMs=2000',
    '/metrics?workspaceId=ws-a&startMs=%20&endMs=2000', // whitespace must not become 0
  ];
  for (const path of cases) {
    const h = harness();
    await h.router({ method: 'GET', headers: {} }, {}, new URL(`http://local/api/observability${path}`));
    assert.equal(h.writes[0]?.status, 400, path);
    assert.equal(h.writes[0]?.response.error.code, 'OBSERVABILITY_QUERY_INVALID', path);
    assert.deepEqual(h.calls, [], path);
  }
});

test('a range of one instant is valid and an absent range adds no range keys (#4296)', async () => {
  const instant = harness();
  await instant.router({ method: 'GET', headers: {} }, {}, new URL('http://local/api/observability/runs?workspaceId=ws-a&startMs=0&endMs=0'));
  assert.equal(instant.writes[0].status, 200);
  assert.equal(instant.calls[0].input.startMs, 0);
  assert.equal(instant.calls[0].input.endMs, 0);

  const plain = harness();
  await plain.router({ method: 'GET', headers: {} }, {}, new URL('http://local/api/observability/metrics?workspaceId=ws-a'));
  const summary = plain.calls.find(call => call.key === 'summary');
  assert.equal('startMs' in summary.input, false);
  assert.equal('endMs' in summary.input, false);
});
