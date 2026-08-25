const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Kernel = require('../kernel');

function isolatedKernelOptions(root) {
  return {
    loadPlugins: false,
    useSQLite: false,
    memoryStoreUseSQLite: false,
    noLoad: true,
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
    memoryStorePath: path.join(root, 'memory-store.json'),
    memoryStoreDbPath: path.join(root, 'memory-store.db'),
  };
}

function withKernel(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-refactor-3b1-'));
  let kernel;
  try {
    kernel = new Kernel(isolatedKernelOptions(root));
    return run(kernel);
  } finally {
    kernel?.graph?.close?.();
    kernel?.memory?.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('auto-think reports the existing global nodeCount without reading _nodes', { concurrency: false }, () => {
  withKernel((kernel) => {
    let nodeCountCalls = 0;
    const nodeCountArgs = [];
    const logs = [];
    kernel._dreamer = {
      dream: () => [{ from: 'a', to: 'b', confidence: 1, type: 'benzerlik' }],
    };
    kernel.graph.hasAnyEdge = () => false;
    kernel.graph.getNode = () => ({ id: 'present' });
    kernel.graph.nodeCount = (...args) => {
      nodeCountCalls += 1;
      nodeCountArgs.push(args);
      return 42;
    };
    kernel._commitBackgroundEdge = () => ({ decision: 'allow', edge: { id: 'edge' } });
    kernel._autoThinkLog = (message) => logs.push(message);
    Object.defineProperty(kernel.graph, '_nodes', {
      configurable: true,
      get() {
        throw new Error('direct _nodes read');
      },
    });

    assert.doesNotThrow(() => kernel._autoThinkTick());
    assert.equal(nodeCountCalls, 1);
    assert.deepEqual(nodeCountArgs, [[]]);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /42/);
  });
});

test('selfLearn reports a read-only stub instead of claiming an edge delta', { concurrency: false }, () => {
  withKernel((kernel) => {
    kernel.detectGaps = () => ['gap'];
    for (const method of ['edgeCount', 'getNode', 'getEdges', 'getInEdges', 'cosineSimilarity']) {
      kernel.graph[method] = () => {
        throw new Error(`${method} must not run while selfLearn is a stub`);
      };
    }
    Object.defineProperty(kernel.graph, '_edges', {
      configurable: true,
      get() {
        throw new Error('direct _edges read');
      },
    });
    assert.deepEqual(kernel.selfLearn(), { gaps: 1, learned: 0, stub: true });
  });
});

test('selfLearn preserves the empty-gap early return without counting edges', { concurrency: false }, () => {
  withKernel((kernel) => {
    kernel.detectGaps = () => [];
    kernel.graph.edgeCount = () => {
      throw new Error('edgeCount must not run for an empty gap set');
    };

    assert.deepEqual(kernel.selfLearn(), { gaps: 0, learned: 0, stub: true, message: 'Boşluk yok' });
  });
});
