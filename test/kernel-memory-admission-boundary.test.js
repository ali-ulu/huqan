const { isolatedKernelOptions, isolatedGraphOptions } = require('./helpers/isolated-persistence');
const test = require('node:test');
const assert = require('node:assert/strict');
const Kernel = require('../kernel');

function approvedLazyOpts(workspaceId = 'default') {
  return { workspaceId, approvalRequired: true, approvalStatus: 'approved', approvalId: 'apr_lazy_test',
    provenance: { provenanceId: 'prov-lazy-test', sourceType: 'manual', sourceRef: 'test:lazy-known-nodes',
      actor: 'kernel-test', workspaceId, timestamp: '2026-10-18T00:00:00.000Z', trustPolicyVersion: '1.0.0' } };
}

function makeKernel() {
  return new Kernel(isolatedKernelOptions('kernel-memory-admission-boundary', { noLoad: true, useSQLite: false, loadPlugins: false }));
}

test('short real learn avoids full node reads in both admission and canonical write', () => {
  const kernel = makeKernel();
  const original = kernel.graph.getNodes;
  let reads = 0;
  kernel.graph.getNodes = function(...args) { reads++; return original.apply(this, args); };
  const reviewed = kernel.learn('kedi hayvandir');
  assert.equal(reviewed.data.admission.outcome, 'review');
  assert.equal(reviewed.data.learned, 0);
  const written = kernel.learn('kedi hayvandir', approvedLazyOpts());
  assert.equal(written.data.admission.outcome, 'allow');
  assert.equal(written.data.learned, 1);
  assert.equal(kernel.graph.getEdges('kedi').length, 1);
  assert.equal(reads, 0, 'neither path needs a known-node map for a two-word fact');
});

test('lazy real learn preserves multiword IDs and workspace isolation', () => {
  const kernel = makeKernel();
  kernel.graph.addNode('ALİ YILMAZ', 'unrelated label', null, { workspaceId: 'owned' });
  kernel.graph.addNode('NEW YORK CITY', 'unrelated label', null, { workspaceId: 'other' });
  const subjects = [];
  const extract = kernel.extractFacts;
  kernel.extractFacts = function(...args) {
    const facts = extract.apply(this, args);
    subjects.push(facts.map(fact => fact.subject));
    return facts;
  };
  const named = kernel.learn('Ali Yılmaz doktordur', approvedLazyOpts('owned'));
  assert.equal(named.data.learned, 1);
  assert.ok(subjects.every(facts => facts[0] === 'ali yilmaz'), 'receipt and write must parse the same subject');
  assert.equal(kernel.graph.getEdges('ali yilmaz', 'owned').length, 1);
  subjects.length = 0;
  const isolated = kernel.learn('New York City şehirdir', approvedLazyOpts('owned'));
  assert.equal(isolated.data.learned, 1);
  assert.ok(subjects.every(facts => facts[0] === 'new'), 'another workspace must not supply a multiword ID');
  assert.equal(kernel.graph.getEdges('new york city', 'owned').length, 0);
});

test('lazy SQLite learn retains rollback and restart durability', () => {
  const options = isolatedKernelOptions('lazy-known-nodes-sqlite', { noLoad: false, useSQLite: true, loadPlugins: false });
  options.dbPath = `${options.memoryPath}.db`;
  let kernel = new Kernel(options);
  try {
    assert.equal(kernel.graph.getStats().backend, 'sqlite');
    const addEdge = kernel.graph.addEdge;
    kernel.graph.addEdge = function(...args) {
      addEdge.apply(this, args);
      throw new Error('lazy fixture write failure');
    };
    assert.throws(() => kernel.learn('kedi hayvandir', approvedLazyOpts()), /lazy fixture write failure/);
    assert.equal(kernel.graph.getNode('kedi'), null);
    kernel.graph.closeSqlite(); kernel.memory.close();
    kernel = new Kernel(options);
    assert.equal(kernel.graph.getNode('kedi'), null, 'failed write must remain absent after restart');
    assert.equal(kernel.learn('kedi hayvandir', approvedLazyOpts()).data.learned, 1);
    kernel.graph.closeSqlite(); kernel.memory.close();
    kernel = new Kernel(options);
    assert.equal(kernel.graph.getEdges('kedi').length, 1, 'successful write must survive restart');
  } finally {
    kernel.graph.closeSqlite(); kernel.memory.close();
  }
});

test('kernel.learn with admissionRequired reviews direct write without approved context', () => {
  const kernel = makeKernel();
  const result = kernel.learn('kedi hayvandir', {
    workspaceId: 'default',
    admissionRequired: true,
    approvalRequired: true,
    sourceType: 'upload',
    sourceRef: 'test:kernel-admission',
    actor: 'kernel-test',
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.learned, 0);
  assert.equal(result.data.admission.outcome, 'review');
  assert.deepEqual(Object.keys(kernel.graph.getNodes('default')), []);
});

test('kernel.learn with approved admission context writes canonical graph state', () => {
  const kernel = makeKernel();
  const result = kernel.learn('kedi hayvandir', {
    workspaceId: 'default',
    admissionRequired: true,
    approvalRequired: true,
    approvalStatus: 'approved',
    approvalId: 'apr_kernel_test_001',
    provenance: {
      provenanceId: 'prov-kernel-test-001',
      sourceType: 'manual',
      sourceRef: 'test:kernel-admission',
      actor: 'kernel-test',
      workspaceId: 'default',
      timestamp: '2026-06-16T00:00:00.000Z',
      trustPolicyVersion: '1.0.0',
    },
  });

  assert.equal(result.ok, true);
  assert.ok(result.data.learned > 0);
  assert.equal(result.data.admission.outcome, 'allow');
  assert.ok(kernel.graph.getEdges('kedi', 'default').length > 0);
});

test('kernel.learnFromLLM does not auto-write canonical graph without approved admission', () => {
  const kernel = makeKernel();
  const result = kernel.learnFromLLM('kedi hayvandir.');

  assert.equal(result.learned, 0);
  assert.ok(result.skipped >= 1);
  assert.deepEqual(Object.keys(kernel.graph.getNodes('default')), []);
});
