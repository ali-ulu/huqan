const assert = require('node:assert/strict');
const fs = require('node:fs');
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
    assert.deepEqual(record, {
      event: 'observability.workflow_run_finished',
      requestId: 'req-1',
      traceId: 'trace-1',
      runId: 'run-1',
      workspaceId: 'workspace-1',
      durationMs: 42,
      outcome: 'completed',
      runtime: 'workflow',
    });
    for (const forbidden of ['goal', 'prompt', 'output', 'secret', 'credential']) assert.equal(Object.hasOwn(record, forbidden), false);
  });

  await t.test('never lets a logger failure alter the caller path', () => {
    assert.doesNotThrow(() => writeStructuredLog({ error() { throw new Error('sink down'); } }, 'error', 'http.failed', { requestId: 'req-1' }, { errorCode: 'FAILED' }));
  });

  await t.test('wires the context and structured logger at production boundaries', () => {
    assert.match(serverSource, /createRequestCorrelation\(req, res\)/);
    assert.match(serverSource, /writeStructuredLog\(console, 'error', 'http\.unhandled_error'/);
    assert.match(runtimeSource, /writeStructuredLog\(console, 'info', 'observability\.workflow_run_started'/);
    assert.match(runtimeSource, /writeStructuredLog\(console, 'info', 'observability\.workflow_run_finished'/);
    assert.match(runtimeSource, /writeStructuredLog\(console, 'error', 'observability\.workflow_run_failed'/);
    assert.match(runtimeSource, /traceId: step\.traceId \|\| traceId/);
  });
});
