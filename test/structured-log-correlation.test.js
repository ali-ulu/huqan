const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  createRequestCorrelation,
  normalizeId,
  writeStructuredLog,
} = require('../lib/http/structured-log');
const { createServerRequestHandler } = require('../lib/http/server-request-handler');

const requestHandlerSource = fs.readFileSync('lib/http/server-request-handler.js', 'utf8');
const runtimeSource = fs.readFileSync('lib/observability/server-runtime.js', 'utf8');

test('structured correlation logging contract', async t => {
  await t.test('normalizes only bounded correlation identifiers', () => {
    assert.equal(normalizeId(' trace-123 '), 'trace-123');
    assert.equal(normalizeId('run:abc_01'), 'run:abc_01');
    assert.equal(normalizeId('trace id'), '');
    assert.equal(normalizeId('trace\nforged'), '');
    assert.equal(normalizeId('x'.repeat(129)), '');
    assert.equal(normalizeId(null), '');
  });

  await t.test('attaches a request ID header without trusting request input', () => {
    const req = { headers: { 'x-request-id': 'caller-controlled' } };
    const headers = {};
    const res = { headersSent: false, setHeader(name, value) { headers[name] = value; } };
    const context = createRequestCorrelation(req, res);
    assert.match(context.requestId, /^req-[0-9a-f-]{36}$/);
    assert.match(context.traceId, /^trace-[0-9a-f-]{36}$/);
    assert.equal(headers['X-Request-Id'], context.requestId);
    assert.equal(req.huqanCorrelation, context);
    assert.notEqual(context.requestId, req.headers['x-request-id']);
  });

  await t.test('emits bounded JSON metadata and excludes sensitive payload fields', () => {
    const lines = [];
    const record = writeStructuredLog(
      { info(line) { lines.push(line); } },
      'info',
      'observability.workflow_run_finished',
      { requestId: 'req-1', runId: 'run-1', traceId: 'trace-1' },
      {
        workspaceId: 'workspace-1', runtime: 'workflow', outcome: 'completed', durationMs: 42,
        goal: 'do not log this goal', prompt: 'do not log this prompt', output: 'do not log this output',
        secret: 'do not log this secret', credential: 'do not log this credential',
      },
    );
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), record);
    assert.equal(record.event, 'observability.workflow_run_finished');
    assert.equal(record.reason, 'completed');
    assert.match(record.request_id, /^[0-9a-f-]{36}$/);
    assert.equal(Number.isNaN(Date.parse(record.timestamp)), false);
    assert.equal(record.workspace_id, 'workspace-1');
    assert.equal(record.level, 'info');
    assert.equal(record.requestId, 'req-1');
    assert.equal(record.traceId, 'trace-1');
    assert.equal(record.runId, 'run-1');
    assert.equal(record.workspaceId, 'workspace-1');
    assert.equal(record.durationMs, 42);
    assert.equal(record.outcome, 'completed');
    assert.equal(record.runtime, 'workflow');
    for (const forbidden of ['goal', 'prompt', 'output', 'secret', 'credential']) assert.equal(Object.hasOwn(record, forbidden), false);
  });

  await t.test('honors HUQAN_LOG_LEVEL without changing returned records', () => {
    const original = process.env.HUQAN_LOG_LEVEL;
    process.env.HUQAN_LOG_LEVEL = 'warn';
    try {
      const lines = [];
      const record = writeStructuredLog({ info(line) { lines.push(line); } }, 'info', 'filtered.info', {}, {});
      assert.equal(lines.length, 0);
      assert.equal(record.level, 'info');
      assert.equal(record.workspace_id, 'system');
    } finally {
      if (original === undefined) delete process.env.HUQAN_LOG_LEVEL;
      else process.env.HUQAN_LOG_LEVEL = original;
    }
  });

  await t.test('never lets a logger failure alter the caller path', () => {
    assert.doesNotThrow(() => writeStructuredLog({ error() { throw new Error('sink down'); } }, 'error', 'http.failed', { requestId: 'req-1' }, { errorCode: 'FAILED' }));
  });


  await t.test('keeps one correlation identity from the HTTP response header through the structured error log', async () => {
    const req = {
      method: 'GET',
      url: '/health',
      headers: { host: 'localhost', 'x-request-id': 'caller-controlled' },
      socket: { remoteAddress: '198.51.100.212' },
    };
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
        const error = new Error('forced correlation probe');
        error.code = 'CORRELATION_PROBE_FAILED';
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
    assert.equal(record.reason, 'CORRELATION_PROBE_FAILED');
    assert.equal(record.requestId, res.headers['X-Request-Id']);
    assert.equal(record.request_id, res.headers['X-Request-Id'].slice(4));
    assert.equal(record.traceId, req.huqanCorrelation.traceId);
  });

  await t.test('wires the context and structured logger at production boundaries', () => {
    assert.match(requestHandlerSource, /createRequestCorrelation\(req, res\)/);
    assert.match(requestHandlerSource, /writeStructuredLog\(console, 'error', 'http\.unhandled_error'/);
    const instrumentationSource = fs.readFileSync(path.join(__dirname, '../lib/observability/workflow-agent-instrumentation.js'), 'utf8');
    assert.match(instrumentationSource, /writeStructuredLog\(console, 'info', 'observability\.workflow_run_started'/);
    assert.match(instrumentationSource, /writeStructuredLog\(console, 'info', 'observability\.workflow_run_finished'/);
    assert.match(instrumentationSource, /writeStructuredLog\(console, 'error', 'observability\.workflow_run_failed'/);
    assert.match(instrumentationSource, /traceId: step\.traceId \|\| traceId/);
  });
});
