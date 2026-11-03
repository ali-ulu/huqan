'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const companyBrain = require('../plugins/company-brain');

const DECISION = {
  title: 'Veri saklama politikasi',
  rationale: 'GDPR uyumu',
  date: '2026-08-23',
  decidedBy: 'ali',
};

function makeKernel({ withJournal = false } = {}) {
  const edges = [];
  const journal = new Map();
  const kernel = {
    edges,
    graph: {
      getStats: () => ({ nodes: 0, edges: edges.length }),
    },
    proposeNode: (id) => ({ decision: 'allow', node: { id } }),
    proposeEdge: (from, to, relation) => {
      edges.push({ from, to, relation });
      return { decision: 'allow', edge: { from, to, relation } };
    },
  };
  if (withJournal) {
    kernel.graph.runMutationOnce = (operationId, run) => {
      if (journal.has(operationId)) {
        return { result: journal.get(operationId), replayed: true, receipt: { receiptId: 'r-' + operationId } };
      }
      const result = run();
      journal.set(operationId, result);
      return { result, replayed: false, receipt: { receiptId: 'r-' + operationId } };
    };
  }
  return kernel;
}

test('operationId without a journaling backend fails closed', () => {
  const kernel = makeKernel();
  assert.throws(
    () => companyBrain._test.ingestDecision(kernel, { ...DECISION, operationId: 'op-1' }),
    (err) => err && err.code === 'DURABLE_MUTATION_JOURNAL_UNAVAILABLE'
  );
});

test('operationId on a journaling backend commits and reports receipt', () => {
  const kernel = makeKernel({ withJournal: true });
  const result = companyBrain._test.ingestDecision(kernel, { ...DECISION, operationId: 'op-2' });
  assert.equal(result.ok, true);
  assert.equal(result.operationId, 'op-2');
  assert.equal(result.replayed, false);
  assert.equal(result.receiptId, 'r-op-2');
});

test('retry with the same operationId replays without duplicating work', () => {
  const kernel = makeKernel({ withJournal: true });
  const first = companyBrain._test.ingestDecision(kernel, { ...DECISION, operationId: 'op-3' });
  const edgesBefore = kernel.edges.length;
  const second = companyBrain._test.ingestDecision(kernel, { ...DECISION, operationId: 'op-3' });
  assert.equal(second.replayed, true);
  assert.equal(kernel.edges.length, edgesBefore, 'retry must not add new edges');
  assert.equal(second.added, first.added);
});

test('mutationOperationId alias is accepted', () => {
  const kernel = makeKernel({ withJournal: true });
  const result = companyBrain._test.ingestDecision(kernel, { ...DECISION, mutationOperationId: 'op-4' });
  assert.equal(result.operationId, 'op-4');
});

test('no operationId keeps legacy non-journaled behavior', () => {
  const kernel = makeKernel();
  const result = companyBrain._test.ingestDecision(kernel, DECISION);
  assert.equal(result.ok, true);
  assert.equal(result.operationId, undefined);
  assert.equal(result.replayed, undefined);
});

test('replay receipt carries replayed true and original receiptId', () => {
  const kernel = makeKernel({ withJournal: true });
  companyBrain._test.ingestDecision(kernel, { ...DECISION, operationId: 'op-r1' });
  const replay = companyBrain._test.ingestDecision(kernel, { ...DECISION, operationId: 'op-r1' });
  assert.equal(replay.replayed, true);
  assert.equal(replay.receiptId, 'r-op-r1');
  assert.equal(replay.operationId, 'op-r1');
});

test('public companyBrain.run forwards operationId and receiptId through journal flow', async () => {
  const kernel = makeKernel({ withJournal: true });
  const result = await companyBrain.run(kernel, {
    action: 'decision',
    title: DECISION.title,
    rationale: DECISION.rationale,
    date: DECISION.date,
    decidedBy: DECISION.decidedBy,
    operationId: 'pub-op-1',
  });
  assert.equal(result.ok, true);
  assert.equal(result.operationId, 'pub-op-1');
  assert.equal(result.replayed, false);
  assert.equal(result.receiptId, 'r-pub-op-1');
});

test('a journal outcome without a receipt reports a null receiptId', () => {
  const kernel = makeKernel({ withJournal: true });
  kernel.graph.runMutationOnce = (operationId, run) => ({ result: run(), replayed: false });
  const result = companyBrain._test.ingestDecision(kernel, { ...DECISION, operationId: 'op-no-receipt' });
  assert.equal(result.ok, true);
  assert.equal(result.operationId, 'op-no-receipt');
  assert.equal(result.receiptId, null);
});

test('a bare `id` on the receipt is accepted as the receiptId', () => {
  const kernel = makeKernel({ withJournal: true });
  kernel.graph.runMutationOnce = (operationId, run) => ({ result: run(), replayed: false, receipt: { id: 'bare-' + operationId } });
  const result = companyBrain._test.ingestDecision(kernel, { ...DECISION, operationId: 'op-bare-id' });
  assert.equal(result.receiptId, 'bare-op-bare-id');
});

test('a receipt carrying no id at all falls back to null', () => {
  const kernel = makeKernel({ withJournal: true });
  kernel.graph.runMutationOnce = (operationId, run) => ({ result: run(), replayed: false, receipt: {} });
  const result = companyBrain._test.ingestDecision(kernel, { ...DECISION, operationId: 'op-empty-receipt' });
  assert.equal(result.receiptId, null);
});

test('a journal outcome without a result field is spread directly', () => {
  const kernel = makeKernel({ withJournal: true });
  kernel.graph.runMutationOnce = () => ({ ok: true, added: 0, replayed: false });
  const result = companyBrain._test.ingestDecision(kernel, { ...DECISION, operationId: 'op-bare-outcome' });
  assert.equal(result.ok, true);
  assert.equal(result.operationId, 'op-bare-outcome');
});

test('a null journal outcome degrades to an empty result without throwing', () => {
  const kernel = makeKernel({ withJournal: true });
  kernel.graph.runMutationOnce = () => null;
  const result = companyBrain._test.ingestDecision(kernel, { ...DECISION, operationId: 'op-null-outcome' });
  assert.equal(result.operationId, 'op-null-outcome');
  assert.equal(result.receiptId, null);
});

// Real kernel + Graph journal (no mocked runMutationOnce): the batch boundary
// must hold on the actual backend, not only on a stub.
const { isolatedKernelOptions } = require('./helpers/isolated-persistence');

function makeRealKernel(useSQLite) {
  const Kernel = require('../kernel');
  const opts = isolatedKernelOptions('company-brain-batch-op', {
    noLoad: true,
    useSQLite,
    paranoidMode: false,
    capabilities: { companyMode: true, pluginCapabilities: true, temporal: true },
  });
  if (useSQLite) opts.dbPath = opts.memoryPath.replace(/memory\.json$/, 'memory.db');
  return new Kernel(opts);
}

function graphCounts(kernel) {
  const { nodes, edges, backend } = kernel.graph.getStats();
  return { nodes, edges, backend };
}

for (const useSQLite of [false, true]) {
  const backend = useSQLite ? 'SQLite' : 'JSON';
  test(`${backend}: mid-batch crash leaves no partial batch and a same-ID retry commits once`, (t) => {
    const kernel = makeRealKernel(useSQLite);
    t.after(() => { try { kernel.graph.close?.(); } catch { /* already closed */ } });
    const input = { ...DECISION, alternatives: ['Alt A', 'Alt B'], operationId: `crash-${backend}` };
    const before = graphCounts(kernel);
    assert.equal(before.backend, useSQLite ? 'sqlite' : 'json', 'test must exercise the intended backend');

    const realProposeEdge = kernel.proposeEdge.bind(kernel);
    let calls = 0;
    kernel.proposeEdge = (...args) => {
      calls += 1;
      if (calls === 3) throw new Error('simulated mid-batch crash');
      return realProposeEdge(...args);
    };
    assert.throws(() => companyBrain._test.ingestDecision(kernel, input), /simulated mid-batch crash/);
    assert.ok(calls === 3, 'the crash must happen after earlier proposals in the batch were admitted');
    assert.deepEqual(graphCounts(kernel), before, 'a crashed batch must not leave partial canonical writes');

    kernel.proposeEdge = realProposeEdge;
    const retry = companyBrain._test.ingestDecision(kernel, input);
    assert.equal(retry.ok, true);
    assert.equal(retry.replayed, false, 'a retry after a rolled-back crash is a first execution');
    assert.equal(retry.added, 3);
    const afterCommit = graphCounts(kernel);
    assert.equal(afterCommit.edges, before.edges + 3);

    const committed = kernel.graph.getCommittedMutationResultByOperation(input.operationId);
    assert.equal(committed.result.added, 3, 'the journal records what the batch committed under its operation ID');
    assert.equal(committed.result.admission.outcome, retry.admission.outcome);
    // No canonical admission receipt is chained for a decision batch; the
    // journaled result is the batch record, so receiptId stays null.
    assert.equal(retry.receiptId, null);
    const decisionCount = () => companyBrain._test.ensureCompanyState(kernel).bySource.decision;
    assert.equal(decisionCount(), 3, 'only the committed attempt counts toward ingest status');

    const replay = companyBrain._test.ingestDecision(kernel, input);
    assert.equal(decisionCount(), 3, 'a replay must not count the decision again');
    assert.equal(replay.replayed, true);
    assert.equal(replay.added, retry.added, 'replay reports what the original attempt committed');
    assert.deepEqual(graphCounts(kernel), afterCommit, 'a same-ID retry must not duplicate accepted work');
  });
}

test('a rejected decision input is not counted on either path', () => {
  const kernel = makeKernel({ withJournal: true });
  const legacy = companyBrain._test.ingestDecision(kernel, { title: '' });
  const journaled = companyBrain._test.ingestDecision(kernel, { title: '', operationId: 'op-invalid' });
  assert.equal(legacy.ok, false);
  assert.equal(journaled.ok, false);
  assert.equal(companyBrain._test.ensureCompanyState(kernel).bySource.decision, 0);
});
