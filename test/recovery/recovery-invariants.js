'use strict';

const assert = require('node:assert/strict');

const { GENESIS_PREVIOUS_HASH, validateReceiptChain } = require('../../lib/receipt/receipt-chain');
const { readMutationJournal } = require('../../lib/mutation-journal');

function snapshotGraph(graph, workspaceId = 'default') {
  const nodes = graph.getNodes(workspaceId);
  const nodeIds = Object.keys(nodes).sort();
  const edges = nodeIds
    .flatMap((nodeId) => graph.getEdges(nodeId, workspaceId))
    .map((edge) => ({
      from: edge.from,
      to: edge.to,
      relation: edge.relation,
      workspaceId: edge.workspaceId || workspaceId,
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));

  return Object.freeze({
    workspaceId,
    nodeIds,
    edges,
    nodeCount: graph.nodeCount(workspaceId),
    edgeCount: graph.edgeCount(workspaceId),
  });
}

function assertGraphConsistent(graph, workspaceId = 'default') {
  const snapshot = snapshotGraph(graph, workspaceId);
  const ids = new Set(snapshot.nodeIds);

  assert.equal(snapshot.nodeCount, snapshot.nodeIds.length, 'node count must match readable nodes');
  assert.equal(snapshot.edgeCount, snapshot.edges.length, 'edge count must match readable outgoing edges');
  for (const edge of snapshot.edges) {
    assert.ok(ids.has(edge.from), `dangling edge source: ${edge.from}`);
    assert.ok(ids.has(edge.to), `dangling edge target: ${edge.to}`);
  }
  return snapshot;
}

function assertPreFaultStatePreserved(before, after) {
  const afterIds = new Set(after.nodeIds);
  for (const id of before.nodeIds) assert.ok(afterIds.has(id), `pre-fault node lost: ${id}`);
  const afterEdges = new Set(after.edges.map((edge) => JSON.stringify(edge)));
  for (const edge of before.edges) {
    assert.ok(afterEdges.has(JSON.stringify(edge)), `pre-fault edge lost: ${JSON.stringify(edge)}`);
  }
}

function assertRollback(before, after) {
  assert.deepEqual(after, before, 'failed mutation must fully roll back');
}

function assertJournalConsistent(journalPath) {
  const journal = readMutationJournal(journalPath);
  const receiptEntries = Object.entries(journal.receipts);
  const receiptHashes = new Set(receiptEntries.map(([, receipt]) => receipt.receiptHash));

  for (const [operationId, operation] of Object.entries(journal.operations)) {
    if (operation.status !== 'completed' || !operation.receiptId) continue;
    const receipt = journal.receipts[operationId];
    assert.ok(receipt, `completed operation ${operationId} is missing its receipt`);
    assert.equal(receipt.receiptId, operation.receiptId, `receipt id mismatch for ${operationId}`);
    assert.equal(journal.receiptsById[receipt.receiptId], operationId, `receipt index mismatch for ${operationId}`);
  }

  for (const [operationId, receipt] of receiptEntries) {
    const record = {
      ...receipt.canonicalPayload,
      previousReceiptHash: receipt.previousReceiptHash,
      receiptHash: receipt.receiptHash,
    };
    const self = validateReceiptChain([record], { genesisPreviousHash: receipt.previousReceiptHash });
    assert.equal(self.valid, true, `receipt content tampered for ${operationId}: ${self.reason}`);
    if (receipt.previousReceiptHash !== GENESIS_PREVIOUS_HASH) {
      assert.ok(receiptHashes.has(receipt.previousReceiptHash), `receipt predecessor missing for ${operationId}`);
    }
  }

  for (const [chainKey, tip] of Object.entries(journal.chainTips)) {
    assert.ok(receiptHashes.has(tip), `chain tip ${chainKey} does not point at a stored receipt`);
  }

  return journal;
}

function assertRecoveryInvariants({ graph, journalPath, workspaceId = 'default', before = null }) {
  const after = assertGraphConsistent(graph, workspaceId);
  if (before) assertPreFaultStatePreserved(before, after);
  if (journalPath) assertJournalConsistent(journalPath);
  return after;
}

module.exports = {
  snapshotGraph,
  assertGraphConsistent,
  assertPreFaultStatePreserved,
  assertRollback,
  assertJournalConsistent,
  assertRecoveryInvariants,
};
