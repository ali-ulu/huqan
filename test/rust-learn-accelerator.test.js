'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const RustGraph = require('../rustGraph');

const resolveRustBin = RustGraph.resolveRustBin;

test('Rust binary resolution honors canonical and legacy compatible environment variables', () => {
  const configured = path.join('/tmp', 'huqan-custom', 'huqan-core');
  assert.equal(resolveRustBin({ HUQAN_RUST_BIN: configured }), path.resolve(configured));
  assert.equal(resolveRustBin({ AXIOM_RUST_BIN: configured }), path.resolve(configured));
});

test('Rust binary resolution rejects conflicting canonical and legacy values', () => {
  assert.throws(
    () => resolveRustBin({ HUQAN_RUST_BIN: '/tmp/huqan-a', AXIOM_RUST_BIN: '/tmp/huqan-b' }),
    (error) => error.code === 'HUQAN_ENV_CONFLICT',
  );
});

test('RustGraph.learnBatch sends all statements in one batch and preserves workspace', async () => {
  const graph = new RustGraph({ memoryPath: 'unused.json' });
  const calls = [];
  graph._send = async (command) => {
    calls.push(command);
    return { ok: true, results: [{ ok: true }, { ok: true }] };
  };

  try {
    const result = await graph.learnBatch(['kedi hayvandir', 'kopek memelidir'], { workspaceId: 'ws-a' });
    assert.deepEqual(result, { ok: true, results: [{ ok: true }, { ok: true }] });
    assert.deepEqual(calls, [{
      cmd: 'batch',
      commands: [
        { cmd: 'learn', text: 'kedi hayvandir', workspaceId: 'ws-a' },
        { cmd: 'learn', text: 'kopek memelidir', workspaceId: 'ws-a' },
      ],
    }]);
  } finally {
    graph.destroy();
  }
});

test('RustGraph.learnBatch fails closed when the adapter has degraded to JS fallback', async () => {
  const graph = new RustGraph({ memoryPath: 'unused.json' });
  const fallback = {};
  graph._fallback = fallback;
  graph._send = async () => fallback;

  try {
    assert.deepEqual(await graph.learnBatch(['kedi hayvandir']), {
      ok: false,
      results: [],
      error: 'rust_unavailable',
    });
  } finally {
    graph.destroy();
  }
});
