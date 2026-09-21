const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  createRequestCorrelation,
  normalizeId,
  writeStructuredLog,
} = require('../lib/http/structured-log');

const serverSource = fs.readFileSync('server.js', 'utf8');
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

  await t.test('wires the context and structured logger at production boundaries', () => {
    assert.match(serverSource, /createRequestCorrelation\(req, res\)/);
    assert.match(serverSource, /writeStructuredLog\(console, 'error', 'http\.unhandled_error'/);
    const instrumentationSource = fs.readFileSync(path.join(__dirname, '../lib/observability/workflow-agent-instrumentation.js'), 'utf8');
    assert.match(instrumentationSource, /writeStructuredLog\(console, 'info', 'observability\.workflow_run_started'/);
    assert.match(instrumentationSource, /writeStructuredLog\(console, 'info', 'observability\.workflow_run_finished'/);
    assert.match(instrumentationSource, /writeStructuredLog\(console, 'error', 'observability\.workflow_run_failed'/);
    assert.match(instrumentationSource, /traceId: step\.traceId \|\| traceId/);
  });
});
