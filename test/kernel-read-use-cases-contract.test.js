'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Kernel = require('../kernel');

function makeKernel(label) {
  const root = path.join(os.tmpdir(), `huqan-read-use-cases-${process.pid}-${label}`);
  return new Kernel({
    noLoad: true,
    loadPlugins: false,
    useSQLite: false,
    memoryStoreUseSQLite: false,
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
    memoryStorePath: path.join(root, 'memory-store.json'),
    memoryStoreDbPath: path.join(root, 'memory-store.db'),
  });
}

function closeKernel(kernel) {
  kernel.graph.close();
  kernel.memory.close();
}

test('Kernel delegates entropy and gap inspection through read use cases', () => {
  const kernel = makeKernel('delegation');
  const calls = [];
  const originalEntropy = kernel._readUseCases.entropy;
  const originalDetectGaps = kernel._readUseCases.detectGaps;

  kernel._readUseCases = {
    entropy(workspaceId) {
      calls.push(['entropy', workspaceId]);
      return originalEntropy(workspaceId);
    },
    detectGaps(workspaceId) {
      calls.push(['detectGaps', workspaceId]);
      return originalDetectGaps(workspaceId);
    },
  };

  try {
    assert.equal(kernel.entropy('workspace-a'), 0);
    assert.deepEqual(kernel.detectGaps('workspace-a'), []);
    assert.deepEqual(calls, [
      ['entropy', 'workspace-a'],
      ['detectGaps', 'workspace-a'],
    ]);
  } finally {
    closeKernel(kernel);
  }
});

test('read use cases preserve entropy and detectGaps observable results', () => {
  const kernel = makeKernel('parity');

  try {
    kernel.graph.addNode('a', 'a', null, { workspaceId: 'workspace-a' });
    kernel.graph.addNode('b', 'b', null, { workspaceId: 'workspace-a' });
    kernel.graph.addNode('c', 'c', null, { workspaceId: 'workspace-a' });
    kernel.graph.addEdge('a', 'b', 'related', { weight: 0.25, workspaceId: 'workspace-a' });
    kernel.graph.addEdge('a', 'c', 'related', { weight: 0.75, workspaceId: 'workspace-a' });

    const expectedEntropy = -((0.25 / 1) * Math.log(0.25 / 1)) - ((0.75 / 1) * Math.log(0.75 / 1));

    assert.equal(kernel.entropy('workspace-a'), expectedEntropy);
    assert.deepEqual(kernel.detectGaps('workspace-a'), ['b', 'c']);
    assert.equal(kernel.entropy('workspace-b'), 0);
    assert.deepEqual(kernel.detectGaps('workspace-b'), []);
  } finally {
    closeKernel(kernel);
  }
});
