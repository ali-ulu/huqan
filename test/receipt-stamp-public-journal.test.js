'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Graph = require('../graph');
const { getReceiptStamp, getReceiptFamilyById } = require('../lib/receipt/receipt-stamp');
const { buildCanonicalReceiptPayload } = require('../lib/receipt/canonical-receipt');

function makeGraph(root) {
  return new Graph({ memoryPath: path.join(root, 'memory.json'), useSQLite: false });
}

function makePayload(receiptId, createdAt) {
  return buildCanonicalReceiptPayload({
    receiptId,
    receiptKind: 'memory_admission_receipt',
    decision: 'allow',
    status: 'admitted',
    admissionId: `admission-${receiptId}`,
    workspaceId: 'workspace-a',
    provenanceId: `prov-${receiptId}`,
    trustPolicyVersion: 'test',
    createdAt,
  }, { verdict: 'allow' });
}

test('2352: receipt-stamp reads the journal through the documented Graph surface', () => {
  assert.equal(typeof Graph.prototype.readJsonJournal, 'function');
});

test('2352: stamp and family resolve from the JSON journal without private access', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-2352-stamp-'));
  const graph = makeGraph(root);
  try {
    const committed = graph.runMutationOnce('op-2352-1', () => ({ ok: true }), {
      buildCanonicalReceipt: () => makePayload('stamp-2352-1', '2026-01-01T00:00:00.000Z'),
    });
    graph.appendAuditEvent({
      eventType: 'TRUST_RECEIPT_MATERIALIZED',
      targetType: 'trust_receipt',
      targetId: committed.receipt.receiptId,
      workspaceId: 'workspace-a',
      timestamp: committed.receipt.canonicalPayload.createdAt,
      details: { receipt: committed.receipt.canonicalPayload },
    }, { workspaceId: 'workspace-a' });
    const reader = graph.readJsonJournal.bind(graph);
    assert.deepEqual(getReceiptStamp(graph, 'workspace-a', 'v4', { readJsonJournal: reader }), {
      generation: 1,
      receiptCount: 1,
      headHash: committed.receipt.receiptHash,
    });
    assert.equal(
      getReceiptFamilyById(graph, committed.receipt.receiptId, 'workspace-a', { readJsonJournal: reader }), 'v4');
  } finally {
    graph.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('2352: breaking the public journal reader breaks the stamp', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-2352-stamp-mutate-'));
  const graph = makeGraph(root);
  try {
    const committed = graph.runMutationOnce('op-2352-9', () => ({ ok: true }), {
      buildCanonicalReceipt: () => makePayload('stamp-2352-9', '2026-01-01T00:00:00.000Z'),
    });
    graph.appendAuditEvent({
      eventType: 'TRUST_RECEIPT_MATERIALIZED',
      targetType: 'trust_receipt',
      targetId: committed.receipt.receiptId,
      workspaceId: 'workspace-a',
      timestamp: committed.receipt.canonicalPayload.createdAt,
      details: { receipt: committed.receipt.canonicalPayload },
    }, { workspaceId: 'workspace-a' });
    assert.equal(
      getReceiptStamp(graph, 'workspace-a', 'v4', { readJsonJournal: () => { throw new Error('x'); } }), null);
    const before = getReceiptStamp(graph, 'workspace-a', 'v4', { readJsonJournal: graph.readJsonJournal.bind(graph) });
    assert.equal(before.headHash, committed.receipt.receiptHash);
    assert.notDeepEqual(
      getReceiptStamp(graph, 'workspace-a', 'v4', {
        readJsonJournal: () => ({ receipts: {}, receiptsById: {}, operations: {}, chainTips: {} }),
      }), before);
  } finally {
    graph.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
