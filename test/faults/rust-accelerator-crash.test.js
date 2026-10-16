'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { tempDir } = require('./helpers');

test('Rust accelerator process kill rejects in-flight work instead of hanging or fabricating success', async (t) => {
  const root = tempDir(t, 'huqan-fault-rust-');
  const modulePath = require.resolve('../../rustGraph');
  const previous = process.env.HUQAN_RUST_BIN;

  process.env.HUQAN_RUST_BIN = process.execPath;
  delete require.cache[modulePath];
  const RustGraph = require('../../rustGraph');
  const graph = new RustGraph({
    memoryPath: path.join(root, 'memory.json'),
    requestTimeoutMs: 2000,
  });

  t.after(() => {
    graph.destroy();
    if (previous === undefined) delete process.env.HUQAN_RUST_BIN;
    else process.env.HUQAN_RUST_BIN = previous;
    delete require.cache[modulePath];
  });

  const pending = graph.send({ cmd: 'stats' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(graph._proc, 'fault fixture must have a live accelerator process');
  assert.equal(graph._proc.kill('SIGKILL'), true);

  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error, 'process_exited');
  assert.equal(graph._pending.size, 0);
});
