'use strict';

// #4233 (CWE-345): a durable receipt payload edited in place kept the
// validation cache warm. The cache key was built from `generation`,
// `receiptCount` and the stored `receipt_hash` head -- all write-time columns.
// `mutation_receipts` has no BEFORE UPDATE trigger (unlike `audit_log`), so a
// direct `UPDATE mutation_receipts SET canonical_payload = ...` left every one
// of them unchanged, the stamp stayed identical, and a warm read returned the
// stale `found` while a cold read correctly returned `chain_invalid`.
//
// The stamp now carries a content-sensitive `chainDigest`, recomputed from each
// member's own payload, so an in-place edit misses the cache and the read path
// revalidates.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Graph = require('../graph');
const { buildCanonicalReceiptPayload } = require('../lib/receipt/canonical-receipt');
const { getReceiptStamp } = require('../lib/receipt/receipt-stamp');
const { createReceiptValidationCache } = require('../lib/receipt/receipt-validation-cache');
const { inspectTrustReceipt } = require('../lib/workbench/trust-receipt-inspector');

const WORKSPACE = 'workspace-a';
const RECEIPT_ID = 'receipt-4233';

function payloadFor(receiptId, createdAt) {
  return buildCanonicalReceiptPayload({
    receiptId,
    receiptKind: 'memory_admission_receipt',
    decision: 'allow',
    status: 'admitted',
    admissionId: `admission-${receiptId}`,
    workspaceId: WORKSPACE,
    provenanceId: `provenance-${receiptId}`,
    trustPolicyVersion: 'trust-policy-v1',
    createdAt,
  }, { verdict: 'allow' });
}

function seed(graph) {
  const committed = graph.runMutationOnce('issue-4233-operation', () => ({ ok: true }), {
    buildCanonicalReceipt: () => payloadFor(RECEIPT_ID, '2026-01-01T00:00:00.000Z'),
  });
  graph.appendAuditEvent({
    eventType: 'TRUST_RECEIPT_MATERIALIZED',
    targetType: 'trust_receipt',
    targetId: RECEIPT_ID,
    workspaceId: WORKSPACE,
    timestamp: '2026-01-01T00:00:00.000Z',
    details: { receipt: committed.receipt.canonicalPayload },
  }, { workspaceId: WORKSPACE });
  return committed;
}

test('an in-place edit of a durable receipt payload misses the warm cache (#4233)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-4233-'));
  const graph = new Graph({
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
    useSQLite: true,
  });
  try {
    seed(graph);
    const cache = createReceiptValidationCache();
    const options = { receiptId: RECEIPT_ID, workspaceId: WORKSPACE, source: graph, cache };

    assert.equal(inspectTrustReceipt(options).status, 'found', 'a clean receipt reads as found');
    assert.equal(inspectTrustReceipt(options).status, 'found', 'the second read is served from cache');
    assert.equal(cache.stats().hits, 1);

    const before = getReceiptStamp(graph, WORKSPACE, 'v4');
    assert.match(before.chainDigest, /^[a-f0-9]{64}$/);

    // Edit the durable payload directly: no trigger fires, the stored
    // receipt_hash and every stamp column stay put.
    const row = graph._db.prepare('SELECT canonical_payload FROM mutation_receipts WHERE receipt_id = ?').get(RECEIPT_ID);
    const tampered = JSON.parse(row.canonical_payload);
    tampered.reason = 'tampered-after-commit';
    graph._db.prepare('UPDATE mutation_receipts SET canonical_payload = ? WHERE receipt_id = ?')
      .run(JSON.stringify(tampered), RECEIPT_ID);

    const after = getReceiptStamp(graph, WORKSPACE, 'v4');
    assert.equal(after.generation, before.generation, 'generation is a write-time column and does not move');
    assert.equal(after.receiptCount, before.receiptCount, 'receiptCount does not move');
    assert.equal(after.headHash, before.headHash, 'the stored head does not move');
    assert.notEqual(after.chainDigest, before.chainDigest, 'the content-sensitive digest must move');

    // The cache must no longer serve the pre-tamper verdict.
    assert.equal(inspectTrustReceipt(options).status, 'chain_invalid',
      'a warm read after an in-place edit must revalidate, not return the stale found');
    assert.equal(inspectTrustReceipt({ receiptId: RECEIPT_ID, workspaceId: WORKSPACE, source: graph }).status,
      'chain_invalid', 'the cold read agrees');
  } finally {
    graph.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a clean durable chain keeps a stable digest across reads (#4233)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-4233-stable-'));
  const graph = new Graph({
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
    useSQLite: true,
  });
  try {
    seed(graph);
    const first = getReceiptStamp(graph, WORKSPACE, 'v4');
    const second = getReceiptStamp(graph, WORKSPACE, 'v4');
    assert.deepEqual(second, first, 'an untouched chain produces an identical stamp, so the cache still helps');
  } finally {
    graph.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a durable payload overwritten with non-JSON still moves the digest (#4233)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-4233-unparseable-'));
  const graph = new Graph({
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
    useSQLite: true,
  });
  try {
    seed(graph);
    const before = getReceiptStamp(graph, WORKSPACE, 'v4');
    graph._db.prepare('UPDATE mutation_receipts SET canonical_payload = ? WHERE receipt_id = ?').run('{not json', RECEIPT_ID);
    const after = getReceiptStamp(graph, WORKSPACE, 'v4');
    assert.match(after.chainDigest, /^[a-f0-9]{64}$/, 'an unparseable member still yields a digest');
    assert.notEqual(after.chainDigest, before.chainDigest);
  } finally {
    graph.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the cache refuses a stamp whose chainDigest is not a digest (#4233)', () => {
  const { normalizeStamp } = require('../lib/receipt/receipt-validation-cache');
  const base = {
    sourceId: 'graph', workspaceId: WORKSPACE, schemaFamily: 'v4', receiptId: RECEIPT_ID,
    generation: 1, receiptCount: 1, headHash: 'a'.repeat(64), chainDigest: 'b'.repeat(64),
  };
  assert.equal(normalizeStamp(base).chainDigest, 'b'.repeat(64), 'a well-formed digest is kept');
  assert.equal(normalizeStamp({ ...base, chainDigest: 'not-a-digest' }), null);
  assert.equal(normalizeStamp({ ...base, chainDigest: null }).chainDigest, undefined, 'null means no chain');
});

test('an edit of only the stored receipt_hash column also moves the digest (#4233)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-4233-stored-'));
  const graph = new Graph({
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
    useSQLite: true,
  });
  try {
    seed(graph);
    const before = getReceiptStamp(graph, WORKSPACE, 'v4');
    graph._db.prepare('UPDATE mutation_receipts SET receipt_hash = ? WHERE receipt_id = ?').run('f'.repeat(64), RECEIPT_ID);
    const after = getReceiptStamp(graph, WORKSPACE, 'v4');
    assert.notEqual(after.chainDigest, before.chainDigest, 'the stored hash is part of what the cache keys on');
  } finally {
    graph.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
