'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createServerRequestHandler } = require('../lib/http/server-request-handler');
const { createObservabilityHttpRouter } = require('../lib/observability/http-router');
const {
  collectFailedFiles,
  planAlarmActions,
} = require('../scripts/nightly-failure-alarm');

function responseHarness() {
  const res = new EventEmitter();
  res.headersSent = false;
  res.headers = {};
  res.statusCode = null;
  res.body = '';
  res.setHeader = (name, value) => { res.headers[name] = value; };
  res.writeHead = (status, headers = {}) => {
    res.statusCode = status;
    Object.assign(res.headers, headers);
    res.headersSent = true;
  };
  res.end = (body = '') => {
    res.body += String(body || '');
    res.emit('finish');
  };
  return res;
}

test('Gate B observability: one server-owned request id reaches response and structured error log', async () => {
  const req = {
    method: 'GET',
    url: '/health',
    headers: { host: 'localhost', 'x-request-id': 'caller-controlled' },
    socket: { remoteAddress: '198.51.100.213' },
  };
  const res = responseHarness();
  let releases = 0;
  const notHandled = async () => false;

  const handler = createServerRequestHandler({
    kernel: { graph: {} },
    concurrencyLimiter: {
      tryAcquire: () => true,
      release: () => { releases += 1; },
    },
    denyIfUnauthorized: () => true,
    viewerMount: {
      isViewerPath: () => false,
      checkRateLimit: () => true,
      handle: async () => {},
    },
    externalClientBoundary: null,
    optionalRoutes: { authContext: {}, route: notHandled },
    handleObservabilityRoute: notHandled,
    handleV5PackageImportRoute: notHandled,
    handleV5PreflightRoute: notHandled,
    handleReadWorkflow: notHandled,
    handleWorkflowDataRoute: notHandled,
    handleFitnessDashboardRoute: notHandled,
    handleCoreRoutes: async () => {
      const error = new Error('gate-b-observability-probe');
      error.code = 'GATE_B_OBSERVABILITY_PROBE';
      throw error;
    },
    handleIngestHttpRoutes: notHandled,
    handleReceiptReadRoute: () => false,
    handleWorkbenchRead: () => false,
    handleTrustQueryRoutes: () => false,
    handlePublicApiRoute: notHandled,
  });

  const lines = [];
  const originalError = console.error;
  console.error = (line) => { lines.push(String(line)); };
  try {
    await handler(req, res);
  } finally {
    console.error = originalError;
  }

  assert.equal(res.statusCode, 500);
  assert.equal(releases, 1);
  assert.equal(lines.length, 1);
  assert.match(res.headers['X-Request-Id'], /^req-[0-9a-f-]{36}$/);
  assert.notEqual(res.headers['X-Request-Id'], req.headers['x-request-id']);

  const record = JSON.parse(lines[0]);
  assert.equal(record.event, 'http.unhandled_error');
  assert.equal(record.reason, 'GATE_B_OBSERVABILITY_PROBE');
  assert.equal(record.requestId, res.headers['X-Request-Id']);
  assert.equal(record.request_id, res.headers['X-Request-Id'].slice(4));
  assert.equal(record.traceId, req.huqanCorrelation.traceId);
});

test('Gate B observability: health stays live while readiness fails on dependency loss', async () => {
  const writes = [];
  const route = createObservabilityHttpRouter({
    getService: () => ({}),
    getHealth: () => ({
      inspect: workspaceId => ({
        workspaceId,
        liveness: { ok: true },
        readiness: { ok: false },
        database: { ok: false },
      }),
    }),
    parseJsonRequest: async () => ({}),
    writeJson: (_req, _res, status, body) => writes.push({ status, body }),
    denyIfUnauthorized: () => true,
    authorizeWorkspace: () => ({ allowed: true }),
  });

  await route(
    { method: 'GET' },
    {},
    new URL('http://local/api/observability/health?workspaceId=gate-b'),
  );
  await route(
    { method: 'GET' },
    {},
    new URL('http://local/api/observability/ready?workspaceId=gate-b'),
  );

  assert.equal(writes.length, 2);
  assert.equal(writes[0].status, 200);
  assert.equal(writes[0].body.ok, true);
  assert.equal(writes[1].status, 503);
  assert.equal(writes[1].body.ok, false);
});

test('Gate B observability: a failed nightly shard produces an issue action and the workflow wires it only to scheduled failure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-gate-b-observability-'));
  try {
    fs.writeFileSync(
      path.join(root, 'test-ubuntu-latest-node-22-shard-2-failures.json'),
      JSON.stringify({
        shard: 2,
        total: 5,
        failedFiles: [{ file: 'test/gate-b-red.test.js', status: 1 }],
      }),
    );

    const failedFiles = collectFailedFiles(root);
    const actions = planAlarmActions({
      runId: '2125',
      runUrl: 'https://github.com/ali-ulu/huqan/actions/runs/2125',
      sha: 'gateb2125',
      failedFiles,
      openIssues: [],
    });

    assert.equal(actions.length, 1);
    assert.equal(actions[0].kind, 'create');
    assert.equal(actions[0].title, 'Nightly red: test/gate-b-red.test.js');
    assert.match(actions[0].body, /test\/gate-b-red\.test\.js/);
    assert.match(actions[0].body, /shard 2/i);

    const workflow = fs.readFileSync(
      path.join(__dirname, '..', '.github', 'workflows', 'benchmark.yml'),
      'utf8',
    );
    assert.match(workflow, /schedule:\s*\n\s*- cron:/);
    const job = workflow.slice(workflow.indexOf('  nightly-failure-alarm:'));
    assert.ok(job.startsWith('  nightly-failure-alarm:'));
    assert.match(job, /if:\s*\$\{\{\s*failure\(\)\s*&&\s*github\.event_name\s*==\s*'schedule'\s*\}\}/);
    assert.match(job, /issues:\s*write/);
    assert.match(job, /node scripts\/nightly-failure-alarm\.js/);
    assert.match(job, /gh issue create/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
