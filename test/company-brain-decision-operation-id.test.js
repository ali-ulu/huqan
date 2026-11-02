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