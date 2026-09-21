'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const test = require('node:test');

const RustGraph = require('../rustGraph');

test('RustGraph receives JS fallback construction instead of constructing Graph itself', async () => {
  const originalExistsSync = fs.existsSync;
  const created = [];
  const sentinel = { source: 'injected-fallback' };
  let addNodeArgs = null;
  const fallback = {
    addNode(...args) {
      addNodeArgs = args;
      return sentinel;
    },
  };

  const bridge = new RustGraph({
    memoryPath: 'virtual-memory.json',
    createFallbackGraph(options) {
      created.push(options);
      return fallback;
    },
  });

  fs.existsSync = () => false;
  try {
    const result = await bridge.addNode('node-1', 'Node 1', { workspaceId: 'workspace-a' });

    assert.strictEqual(bridge._fallback, fallback);
    assert.deepStrictEqual(created, [{ memoryPath: 'virtual-memory.json' }]);
    assert.strictEqual(result, sentinel);
    assert.deepStrictEqual(addNodeArgs, [
      'node-1',
      'Node 1',
      undefined,
      { workspaceId: 'workspace-a' },
    ]);
  } finally {
    fs.existsSync = originalExistsSync;
  }
});
