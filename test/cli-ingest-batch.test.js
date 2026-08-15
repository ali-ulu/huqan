'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCliArgv, CLI_EXIT_CODES } = require('../lib/cli-workflow-adapter');
const { MAX_BATCH_ITEMS } = require('../lib/cli-ingest-batch');

function fixture(t, value) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cli-batch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'batch.json');
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

async function invoke(args, deps = {}) {
  const stdout = [];
  const result = await runCliArgv([...args, '--json'], { stdout: value => stdout.push(value) }, deps);
  return { result, envelope: JSON.parse(stdout[0]) };
}

test('batch preview projects manual and decision sources and fails external sources closed', async t => {
  const input = fixture(t, { items: [
    { id: 'manual-1', sourceType: 'manual', workspaceId: 'default', sourceRef: 'note', text: 'bounded note' },
    { id: 'decision-1', sourceType: 'decision', workspaceId: 'default', title: 'Use native fetch', rationale: 'already installed' },
    { id: 'github-1', sourceType: 'github', repoUrl: 'https://github.com/ali-ulu/huqan' },
  ] });
  const { result, envelope } = await invoke(['ingest', 'batch', 'preview', '--input', input]);
  assert.equal(result.exitCode, CLI_EXIT_CODES.partial);
  assert.equal(envelope.workflowId, 'ingest-preview');
  assert.equal(envelope.status, 'partial');
  assert.deepEqual(envelope.data.items.map(item => item.status), [
    'review_required', 'review_required', 'capability_not_available',
  ]);
  assert.equal(envelope.data.items[0].run, null);
  assert.equal(envelope.data.items[1].sourceManifest.sourceType, 'decision');
  assert.deepEqual(envelope.data.items[2].error, {
    code: 'INGEST_SOURCE_UNSUPPORTED',
    message: 'CLI batch ingest supports manual and decision sources only; external connector ingest is unavailable.',
  });
});

test('batch execute uses the canonical HTTP action owner and preserves per-item run/error fields', async t => {
  const input = fixture(t, [
    { id: 'accepted', sourceType: 'manual', workspaceId: 'default', text: 'reviewed text' },
    { id: 'unsupported', sourceType: 'markdown', path: 'notes.md' },
  ]);
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return { json: async () => ({ status: 'review_required', data: { runId: 'approval-7', statusRoute: '/api/v2/ingest/runs/approval-7' }, receiptId: null }) };
  };
  const { result, envelope } = await invoke([
    'ingest', 'batch', 'execute', '--input', input, '--base-url', 'http://127.0.0.1:3210', '--api-key', 'test-token',
  ], { fetch });
  assert.equal(result.exitCode, CLI_EXIT_CODES.partial);
  assert.equal(calls.length, 1, 'unsupported source never reaches the action owner');
  assert.equal(calls[0].url, 'http://127.0.0.1:3210/api/v2/ingest/execute');
  assert.equal(calls[0].options.headers.authorization, 'Bearer test-token');
  assert.deepEqual(envelope.data.items[0].run, { runId: 'approval-7', statusRoute: '/api/v2/ingest/runs/approval-7' });
  assert.equal(envelope.data.items[0].receipt, null);
  assert.equal(envelope.data.items[1].status, 'capability_not_available');
});

test('batch status reuses lifecycle projection and returns a deterministic failed exit', async t => {
  const input = fixture(t, [{ id: 'run-1', runId: 'approval-8', workspaceId: 'default' }]);
  const fetch = async url => {
    assert.equal(url, 'http://127.0.0.1:3210/api/v2/ingest/runs/approval-8?workspaceId=default');
    return { json: async () => ({
      status: 'failed', error: { code: 'INGEST_RUN_STATE_UNKNOWN', message: 'reconcile' }, receiptId: null,
      data: { runId: 'approval-8', phase: 'reconciliation_required', progress: { completed: 0, total: 1, hasMore: false } },
    }) };
  };
  const { result, envelope } = await invoke([
    'ingest', 'batch', 'status', '--input', input, '--base-url', 'http://127.0.0.1:3210',
  ], { fetch });
  assert.equal(result.exitCode, CLI_EXIT_CODES.failed);
  assert.equal(envelope.status, 'failed');
  assert.equal(envelope.data.items[0].run.phase, 'reconciliation_required');
  assert.equal(envelope.data.items[0].error.code, 'INGEST_RUN_STATE_UNKNOWN');
});

test('batch input is bounded and invalid input has the stable exit', async t => {
  const input = fixture(t, Array.from({ length: MAX_BATCH_ITEMS + 1 }, (_, index) => ({ id: index, sourceType: 'manual', text: 'x' })));
  const { result, envelope } = await invoke(['ingest', 'batch', 'preview', '--input', input]);
  assert.equal(result.exitCode, CLI_EXIT_CODES.invalid_input);
  assert.equal(envelope.error.code, 'INVALID_BATCH');
});
