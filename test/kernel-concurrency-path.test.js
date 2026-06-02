const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Kernel = require('../kernel');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-kernel-concurrency-'));

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeKernel(name) {
  const kernel = new Kernel({
    noLoad: true,
    loadPlugins: false,
    useSQLite: false,
    memoryPath: path.join(tempDir, `${name}.json`),
  });
  kernel._autoMaintain = () => {};
  kernel.maintenanceEvery = Number.MAX_SAFE_INTEGER;
  kernel._learnCount = 0;
  return kernel;
}

function unwrap(result) {
  if (result && typeof result === 'object' && result.data && typeof result.data === 'object') {
    return result.data;
  }
  return result;
}

function seed(kernel, statements) {
  for (const statement of statements) {
    kernel.learn(statement, { workspaceId: 'default' });
  }
}

describe('kernel concurrency and path safety', () => {
  it('blocks reentrant verify while learn holds the critical section and releases after completion', () => {
    const kernel = makeKernel('learn-lock');
    const originalAddEdge = kernel.graph.addEdge.bind(kernel.graph);
    let injected = false;

    kernel.graph.addEdge = (...args) => {
      if (!injected) {
        injected = true;
        assert.throws(
          () => kernel.verify('B737 is aircraft', { workspaceId: 'default' }),
          error => error && error.code === 'LOCK_BUSY',
        );
      }
      return originalAddEdge(...args);
    };

    kernel.learn('B737 is aircraft', { workspaceId: 'default' });

    assert.ok(kernel.graph.getNode(kernel.normalizeWord('B737'), 'default'));
  });

  it('blocks reentrant learn while verify holds the critical section and releases after completion', () => {
    const kernel = makeKernel('verify-lock');
    kernel.graph.addNode('alpha', 'alpha', null, { workspaceId: 'default' });
    kernel.graph.addNode('beta', 'beta', null, { workspaceId: 'default' });
    kernel.graph.addNode('gamma', 'gamma', null, { workspaceId: 'default' });
    kernel.graph.addNode('delta', 'delta', null, { workspaceId: 'default' });
    kernel.graph.addEdge('alpha', 'beta', 'linked', { workspaceId: 'default' });
    kernel.graph.addEdge('beta', 'gamma', 'linked', { workspaceId: 'default' });
    kernel.graph.addEdge('gamma', 'delta', 'linked', { workspaceId: 'default' });

    const originalGetEdges = kernel.graph.getEdges.bind(kernel.graph);
    let injected = false;

    kernel.graph.getEdges = (...args) => {
      if (!injected) {
        injected = true;
        assert.throws(
          () => kernel.learn('gadget is device', { workspaceId: 'default' }),
          error => error && error.code === 'LOCK_BUSY',
        );
      }
      return originalGetEdges(...args);
    };

    const raw = kernel.verify('alpha is delta', { workspaceId: 'default' });
    const result = unwrap(raw);

    assert.strictEqual(result.status, 'dogrulandi');
    kernel.learn('gadget is device', { workspaceId: 'default' });
    assert.ok(kernel.graph.getNode(kernel.normalizeWord('gadget'), 'default'));
  });

  it('aborts learn when beforeLearn throws and does not leave partial graph state', () => {
    const kernel = makeKernel('before-learn');
    let failOnce = true;

    kernel.usePlugin({
      name: 'fail-once-before-learn',
      beforeLearn() {
        if (failOnce) {
          failOnce = false;
          throw new Error('boom');
        }
        return undefined;
      },
    });

    assert.throws(() => kernel.learn('B737 is aircraft', { workspaceId: 'default' }), /boom/);
    assert.ok(!kernel.graph.getNode(kernel.normalizeWord('B737'), 'default'));
    assert.ok(!kernel.graph.getNode(kernel.normalizeWord('aircraft'), 'default'));

    kernel.learn('B737 is aircraft', { workspaceId: 'default' });
    assert.ok(kernel.graph.getNode(kernel.normalizeWord('B737'), 'default'));
    assert.ok(Object.keys(kernel.graph.getNodes('default')).length > 0);
  });

  it('returns a safe result for invalid verify input', () => {
    const kernel = makeKernel('invalid-verify');

    const raw = kernel.verify(undefined, { workspaceId: 'default' });
    const result = unwrap(raw);

    assert.strictEqual(result.status, 'bilinmiyor');
    assert.ok(raw.meta && raw.meta.semanticTrust, 'semantic trust metadata should still be present');
  });

  it('reports path timeout and maxDepth when traversals are bounded', () => {
    const kernel = makeKernel('path-guards');
    kernel.graph.addNode('alpha', 'alpha', null, { workspaceId: 'default' });
    kernel.graph.addNode('beta', 'beta', null, { workspaceId: 'default' });
    kernel.graph.addNode('gamma', 'gamma', null, { workspaceId: 'default' });
    kernel.graph.addNode('delta', 'delta', null, { workspaceId: 'default' });
    kernel.graph.addNode('epsilon', 'epsilon', null, { workspaceId: 'default' });
    kernel.graph.addEdge('alpha', 'beta', 'linked', { workspaceId: 'default' });
    kernel.graph.addEdge('beta', 'gamma', 'linked', { workspaceId: 'default' });
    kernel.graph.addEdge('gamma', 'delta', 'linked', { workspaceId: 'default' });
    kernel.graph.addEdge('delta', 'epsilon', 'linked', { workspaceId: 'default' });

    const timeoutResult = kernel._findPathWithTimeout('alpha', 'epsilon', -1, 'default', 5);
    assert.strictEqual(timeoutResult.path, null);
    assert.strictEqual(timeoutResult.stoppedReason, 'timeout');

    const depthResult = kernel._findPathWithTimeout('alpha', 'epsilon', 100, 'default', 2);
    assert.strictEqual(depthResult.path, null);
    assert.strictEqual(depthResult.stoppedReason, 'maxDepth');

    const raw = kernel.verify('alpha is delta', { workspaceId: 'default', pathTimeoutMs: 100 });
    const result = unwrap(raw);
    const pathSearch = raw.meta && raw.meta.semanticTrust && raw.meta.semanticTrust.meta && raw.meta.semanticTrust.meta.pathSearch;

    assert.strictEqual(result.status, 'dogrulandi');
    assert.ok(pathSearch, 'verify should surface path search metadata');
    assert.ok(Array.isArray(pathSearch.path), 'path search should include the resolved path');
    assert.strictEqual(pathSearch.stoppedReason, null);
  });
});
