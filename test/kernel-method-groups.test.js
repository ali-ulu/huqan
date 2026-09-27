'use strict';

// #2122 moved five method groups out of kernel.js into lib/kernel-*-methods.js
// and installs them on Kernel.prototype. These tests pin what the move must
// not change and what no other test caught when it was broken on purpose:
// the SQLite close/reopen pair restore depends on, the workspace a path's
// evidence is read from, and the install shape itself.

const assert = require('node:assert/strict');
const test = require('node:test');

const Kernel = require('../kernel');
const { installKernelMethods } = require('../lib/kernel-method-install');

const GROUPS = Object.freeze({
  'kernel-capability-methods': ['hasCapability', 'enableCapability', 'requireCapability', 'usePlugin', 'listCapabilities', 'getCapability', 'runCapability'],
  'kernel-primitive-methods': ['normalizeWord', 'tokenizeText', 'isStopWord', 'extractFacts', '_envelopeContext', 'ok', 'fail', '_validateResult', '_edgeRef', '_rankEvidence', '_edgeEvidence', '_pathEvidence', '_normalizeExplicitRelationObject', '_parseExplicitRelationPredicate', 'parsePredicate', '_parsePredicate', '_forwardChain', '_backwardChain', '_detectCycle', '_resolveCycleOrder', '_findPath', '_findPathWithTimeout'],
  'kernel-read-methods': ['_contradictionEvidence', 'ask', 'entropy', 'detectGaps', 'reason', 'compare', '_parseNumericComparison', 'verify', 'verifyAsync', '_verifyInternal', 'detectContradictions', '_extractNumbers', '_getTextCore', 'introspect'],
  'kernel-persistence-methods': ['getPersistenceDescriptor', 'reload', 'closeSqlite', 'reopenSqlite', 'persist', 'optimize', 'consolidate'],
  'kernel-learn-input-methods': ['_runPreIngest', '_resolveLearnMetadata', '_learnEdgeOptions', '_normalizeProvenanceInput'],
});

function makeKernel() {
  return new Kernel({ noLoad: true, useSQLite: false, loadPlugins: false, memoryStoreUseSQLite: false });
}

test('every moved method is installed with the descriptor of a class member', () => {
  for (const [group, names] of Object.entries(GROUPS)) {
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(Kernel.prototype, name);
      assert.ok(descriptor, `${group}: Kernel.prototype.${name} is missing`);
      assert.equal(descriptor.enumerable, false, `${name} must stay non-enumerable`);
      assert.equal(descriptor.configurable, true, `${name} must stay configurable`);
      if (name === '_envelopeContext') {
        assert.equal(typeof descriptor.get, 'function', '_envelopeContext must stay a getter');
      } else {
        assert.equal(typeof descriptor.value, 'function', `${name} must stay a method`);
        assert.equal(descriptor.writable, true, `${name} must stay writable`);
      }
    }
  }
  const kernel = makeKernel();
  try {
    assert.deepEqual(Object.keys(kernel).filter((key) => Object.values(GROUPS).flat().includes(key)), []);
  } finally {
    kernel.graph.close();
  }
});

test('installKernelMethods refuses to replace a method Kernel already has', () => {
  class Target { existing() { return 'kept'; } }
  class Holder { existing() { return 'replaced'; } }
  assert.throws(() => installKernelMethods(Target, Holder), /Kernel\.prototype\.existing is already defined/);
  assert.equal(new Target().existing(), 'kept');
});

test('closeSqlite closes graph then memory; reopenSqlite reopens memory then graph', () => {
  const kernel = makeKernel();
  const realGraph = kernel.graph;
  const realMemory = kernel.memory;
  const calls = [];
  try {
    kernel.graph = { closeSqlite: () => calls.push('graph.closeSqlite'), reopen: () => calls.push('graph.reopen') };
    kernel.memory = { close: () => calls.push('memory.close'), reopen: () => calls.push('memory.reopen') };
    kernel.closeSqlite();
    kernel.reopenSqlite();
    assert.deepEqual(calls, ['graph.closeSqlite', 'memory.close', 'memory.reopen', 'graph.reopen']);

    kernel.graph = {};
    kernel.memory = {};
    assert.doesNotThrow(() => { kernel.closeSqlite(); kernel.reopenSqlite(); });
  } finally {
    kernel.graph = realGraph;
    kernel.memory = realMemory;
    kernel.graph.close();
  }
});

test('persistence facades forward to the graph unchanged', () => {
  const kernel = makeKernel();
  const realGraph = kernel.graph;
  const calls = [];
  try {
    kernel.graph = {
      load: () => { calls.push('load'); return 'loaded'; },
      save: () => { calls.push('save'); return 'saved'; },
      optimize: () => { calls.push('optimize'); return 'optimized'; },
      consolidateEdges: (dryRun) => { calls.push(['consolidateEdges', dryRun]); return 'consolidated'; },
    };
    assert.equal(kernel.reload(), 'loaded');
    assert.equal(kernel.persist(), 'saved');
    assert.equal(kernel.optimize(), 'optimized');
    assert.equal(kernel.consolidate(), 'consolidated');
    assert.equal(kernel.consolidate(false), 'consolidated');
    assert.deepEqual(calls, ['load', 'save', 'optimize', ['consolidateEdges', true], ['consolidateEdges', false]]);
  } finally {
    kernel.graph = realGraph;
    kernel.graph.close();
  }
});

test('_pathEvidence reads edges from the workspace it is given', () => {
  const kernel = makeKernel();
  const realGraph = kernel.graph;
  const seen = [];
  try {
    kernel.graph = {
      getEdges: (id, workspaceId) => { seen.push(['out', id, workspaceId]); return [{ from: 'a', to: 'b', relation: 'r' }]; },
      getInEdges: (id, workspaceId) => { seen.push(['in', id, workspaceId]); return []; },
    };
    const evidence = kernel._pathEvidence(['a', 'b'], 'path', 0.7, 'tenant-b');
    assert.deepEqual(seen, [['out', 'a', 'tenant-b'], ['in', 'a', 'tenant-b']]);
    assert.equal(evidence.text, 'a -> b');
    assert.equal(evidence.edges.length, 1);

    seen.length = 0;
    kernel._pathEvidence(['a', 'b']);
    assert.deepEqual(seen, [['out', 'a', 'default'], ['in', 'a', 'default']]);
  } finally {
    kernel.graph = realGraph;
    kernel.graph.close();
  }
});
