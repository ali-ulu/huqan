'use strict';

// #3490 (R35): the read-side half of the issuer seal. Seals are written by
// graph-mutation-receipt-write.js; verifyMutationReceiptSealByOperation
// verifies the signature and binds the signature time to evidence.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Graph = require('../graph');
const { appendReceiptToChain } = require('../lib/receipt/receipt-chain');
const { buildCanonicalReceiptPayload } = require('../lib/receipt/canonical-receipt');
const { sealChainedReceipt } = require('../lib/graph-mutation-receipt-write');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-3490-'));
  const graph = new Graph({
    memoryPath: path.join(dir, 'memory.json'),
    dbPath: path.join(dir, 'memory.db'),
    useSQLite: true,
  });
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { dir, graph, privateKeyPem, publicKeyPem };
}

function payloadFor(receiptId) {
  return buildCanonicalReceiptPayload({
    receiptId,
    receiptKind: 'memory_admission_receipt',
    decision: 'allow',
    status: 'admitted',
    admissionId: `madm_${receiptId}`,
    workspaceId: 'workspace-a',
    provenanceId: 'prov-1',
    trustPolicyVersion: '0.8.0',
    createdAt: '2026-08-19T10:00:00.000Z',
  }, { verdict: 'allow' });
}

function seedSealed(graph, { operationId, receiptId, privateKeyPem, issuedAt }) {
  const chained = appendReceiptToChain(payloadFor(receiptId), null);
  graph._stmts.insertMutationReceipt.run(
    operationId, chained.receiptId, 'workspace-a', 'non-v4',
    JSON.stringify(payloadFor(receiptId)), chained.previousReceiptHash,
    chained.receiptHash, '2026-08-19T10:00:00.000Z',
  );
  const seal = sealChainedReceipt(chained, { privateKeyPem }, { issuedAt, productVersion: '0.13.2' });
  assert.ok(seal);
  graph._stmts.insertMutationReceiptSeal.run(
    seal.receiptHash, seal.receiptId, seal.workspaceId, seal.keyId, JSON.stringify(seal), seal.issuedAt,
  );
  return { chained, seal };
}

function cleanup(dir, graph) {
  try { graph._db?.close(); } catch (_) {}
  fs.rmSync(dir, { recursive: true, force: true });
}

test('a sealed receipt verifies and binds its signature time to evidence', () => {
  const { dir, graph, privateKeyPem, publicKeyPem } = fixture();
  try {
    seedSealed(graph, { operationId: 'op:sealed-1', receiptId: 'r-sealed-1', privateKeyPem, issuedAt: '2026-08-19T10:00:00.000Z' });
    const result = graph.verifyMutationReceiptSealByOperation('op:sealed-1', {
      publicKeyPem,
      evidenceAt: '2026-08-19T10:00:01.000Z',
    });
    assert.equal(result.ok, true);
    assert.equal(result.receiptId, 'r-sealed-1');
    assert.ok(result.keyId.startsWith('ed25519:'));
    assert.equal(result.issuedAt, '2026-08-19T10:00:00.000Z');
    assert.equal(result.ageMs, 1000);
  } finally { cleanup(dir, graph); }
});

test('an unsealed receipt fails closed with seal_absent', () => {
  const { dir, graph, publicKeyPem } = fixture();
  try {
    const chained = appendReceiptToChain(payloadFor('r-bare-1'), null);
    graph._stmts.insertMutationReceipt.run(
      'op:bare-1', chained.receiptId, 'workspace-a', 'non-v4',
      JSON.stringify(payloadFor('r-bare-1')), chained.previousReceiptHash,
      chained.receiptHash, '2026-08-19T10:00:00.000Z',
    );
    const result = graph.verifyMutationReceiptSealByOperation('op:bare-1', { publicKeyPem });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'seal_absent');
  } finally { cleanup(dir, graph); }
});

test('a wrong key fails closed with key_fingerprint_mismatch', () => {
  const { dir, graph, privateKeyPem, publicKeyPem } = fixture();
  try {
    seedSealed(graph, { operationId: 'op:sealed-2', receiptId: 'r-sealed-2', privateKeyPem, issuedAt: '2026-08-19T10:00:00.000Z' });
    const other = crypto.generateKeyPairSync('ed25519').publicKey
      .export({ type: 'spki', format: 'pem' }).toString();
    assert.notEqual(other, publicKeyPem);
    const result = graph.verifyMutationReceiptSealByOperation('op:sealed-2', { publicKeyPem: other });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'key_fingerprint_mismatch');
  } finally { cleanup(dir, graph); }
});

test('a seal post-dating the evidence fails closed', () => {
  const { dir, graph, privateKeyPem, publicKeyPem } = fixture();
  try {
    seedSealed(graph, { operationId: 'op:sealed-3', receiptId: 'r-sealed-3', privateKeyPem, issuedAt: '2026-08-19T10:00:10.000Z' });
    const refused = graph.verifyMutationReceiptSealByOperation('op:sealed-3', {
      publicKeyPem,
      evidenceAt: '2026-08-19T10:00:00.000Z',
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'seal_issued_after_evidence');
    const tolerated = graph.verifyMutationReceiptSealByOperation('op:sealed-3', {
      publicKeyPem,
      evidenceAt: '2026-08-19T10:00:00.000Z',
      toleranceMs: 15_000,
    });
    assert.equal(tolerated.ok, true);
  } finally { cleanup(dir, graph); }
});

test('a missing receipt fails closed with receipt_not_found', () => {
  const { dir, graph, publicKeyPem } = fixture();
  try {
    const result = graph.verifyMutationReceiptSealByOperation('op:nope', { publicKeyPem });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'receipt_not_found');
  } finally { cleanup(dir, graph); }
});
