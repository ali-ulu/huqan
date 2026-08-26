const { isolatedKernelOptions, isolatedGraphOptions } = require('./helpers/isolated-persistence');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Kernel = require('../kernel');

describe('kernel memory integration', () => {
  it('exposes the memory store on the kernel instance', () => {
    const kernel = new Kernel(isolatedKernelOptions('kernel-memory', { noLoad: true, loadPlugins: false, useSQLite: false }));
    assert.ok(kernel.memory);
    assert.strictEqual(typeof kernel.memory.store, 'function');
    assert.strictEqual(typeof kernel.memory.get, 'function');
    assert.strictEqual(typeof kernel.memory.list, 'function');
  });

  it('can store and get memories through kernel.memory', () => {
    const kernel = new Kernel(isolatedKernelOptions('kernel-memory', { noLoad: true, loadPlugins: false, useSQLite: false }));
    const storeRes = kernel.memory.store({
      content: 'Kernel level memory validation test',
      workspaceId: 'workspace-kernel-test'
    });
    assert.strictEqual(storeRes.ok, true);
    assert.ok(storeRes.memory.memoryId);

    const getRes = kernel.memory.get(storeRes.memory.memoryId, {
      workspaceId: 'workspace-kernel-test'
    });
    assert.strictEqual(getRes.ok, true);
    assert.strictEqual(getRes.memory.content, 'Kernel level memory validation test');
  });
});
