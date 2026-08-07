const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Kernel = require('../kernel');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-verify-negation-'));

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeKernel(name) {
  const kernel = new Kernel({
    noLoad: true,
    useSQLite: false,
    memoryPath: path.join(tempDir, `${name}.json`),
    lang: 'en',
  });
  kernel._autoMaintain = () => {};
  kernel.maintenanceEvery = Number.MAX_SAFE_INTEGER;
  kernel._learnCount = 0;
  return kernel;
}

function unwrap(result) {
  return result && typeof result === 'object' && result.data && typeof result.data === 'object'
    ? result.data
    : result;
}

describe('verify Turkish negation predicate matching (#360)', () => {
  it('detects a contradiction for "değil" negation of an existing edge', () => {
    const kernel = makeKernel('degil');
    kernel.graph.addNode('kedi', 'kedi', null, { workspaceId: 'default' });
    kernel.graph.addNode('evcil', 'evcil', null, { workspaceId: 'default' });
    kernel.graph.addEdge('kedi', 'evcil', 'is', { workspaceId: 'default', confidence: 0.9 });

    const raw = kernel.verify('kedi evcil değil', { workspaceId: 'default' });
    const result = unwrap(raw);

    assert.strictEqual(result.status, 'celiski');
  });

  it('detects a contradiction for "değildir" negation of an existing edge', () => {
    const kernel = makeKernel('degildir');
    kernel.graph.addNode('kedi', 'kedi', null, { workspaceId: 'default' });
    kernel.graph.addNode('evcil', 'evcil', null, { workspaceId: 'default' });
    kernel.graph.addEdge('kedi', 'evcil', 'is', { workspaceId: 'default', confidence: 0.9 });

    const raw = kernel.verify('kedi evcil değildir', { workspaceId: 'default' });
    const result = unwrap(raw);

    assert.strictEqual(result.status, 'celiski');
  });
});
