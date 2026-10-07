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

function stubStore({ receipt = null, seal = null, sealKey = null, throwOnReceipt = false } = {}) {
  return {
    hasSqlite: () => false,
    readJsonJournal: () => {
      if (throwOnReceipt) throw new Error('journal unavailable');
      return { receipts: receipt ? { 'op:stub': receipt } : {}, receiptsById: {}, chainTips: {}, seals: seal ? { [sealKey || seal.receiptHash]: seal } : {} };
    },
  };
}

function stubReceipt(hash) {
  return { operationId: 'op:stub', receiptId: 'r-stub', workspaceId: 'w', canonicalPayload: {}, previousReceiptHash: '0'.repeat(64), receiptHash: hash, committedAt: '2026-08-19T10:00:00.000Z' };
}

function stubSeal(hash) {
  return { schemaVersion: 'huqan.issuer-seal.v1', issuedBy: 'huqan', productVersion: '', receiptHash: hash, receiptId: 'r-stub', workspaceId: 'w', issuedAt: '2026-08-19T10:00:00.000Z', keyId: 'ed25519:ab', algorithm: 'ed25519', sealHash: 'sha256:cd', signature: 'eA==' };
}

test('every refusal path is typed and fail-closed', () => {
  const { verifyMutationReceiptSeal } = require('../lib/graph-mutation-receipt-read');
  const verifySeal = () => ({ ok: true, reason: '', keyId: 'ed25519:ab' });
  assert.equal(verifyMutationReceiptSeal(stubStore(), '', { verifySeal }).reason, 'operation_id_required');
  assert.equal(verifyMutationReceiptSeal(stubStore({ throwOnReceipt: true }), 'op:stub', { verifySeal }).reason, 'receipt_not_found');
  assert.equal(verifyMutationReceiptSeal(stubStore(), 'op:stub', { verifySeal }).reason, 'receipt_not_found');
  const noSeal = verifyMutationReceiptSeal(stubStore({ receipt: stubReceipt('h1') }), 'op:stub', { verifySeal });
  assert.equal(noSeal.reason, 'seal_absent');
  assert.equal(noSeal.receiptId, 'r-stub');
  assert.equal(verifyMutationReceiptSeal(stubStore({ receipt: stubReceipt('h1'), seal: stubSeal('h2') }), 'op:stub', { verifySeal }).reason, 'seal_absent');
  const mismatch = verifyMutationReceiptSeal(stubStore({ receipt: stubReceipt('h1'), seal: stubSeal('h2'), sealKey: 'h1' }), 'op:stub', { verifySeal });
  assert.equal(mismatch.reason, 'seal_receipt_mismatch');
  assert.equal(verifyMutationReceiptSeal(stubStore({ receipt: stubReceipt('h1'), seal: stubSeal('h1') }), 'op:stub', { verifySeal: null }).reason, 'seal_verifier_unavailable');
  const denied = verifyMutationReceiptSeal(stubStore({ receipt: stubReceipt('h1'), seal: stubSeal('h1') }), 'op:stub', { verifySeal: () => ({ ok: false, reason: 'signature_invalid' }) });
  assert.equal(denied.reason, 'signature_invalid');
  const silent = verifyMutationReceiptSeal(stubStore({ receipt: stubReceipt('h1'), seal: stubSeal('h1') }), 'op:stub', { verifySeal: () => null });
  assert.equal(silent.reason, 'signature_invalid');
  const badIssued = verifyMutationReceiptSeal(
    stubStore({ receipt: stubReceipt('h1'), seal: { ...stubSeal('h1'), issuedAt: 'not-a-time' } }), 'op:stub', { verifySeal });
  assert.equal(badIssued.reason, 'seal_issued_at_invalid');
  const badEvidence = verifyMutationReceiptSeal(
    stubStore({ receipt: stubReceipt('h1'), seal: stubSeal('h1') }), 'op:stub', { verifySeal, evidenceAt: 'not-a-time' });
  assert.equal(badEvidence.reason, 'evidence_at_invalid');
  const future = verifyMutationReceiptSeal(
    stubStore({ receipt: stubReceipt('h1'), seal: { ...stubSeal('h1'), issuedAt: '2099-01-01T00:00:00.000Z' } }), 'op:stub', { verifySeal, evidenceAt: '2099-01-02T00:00:00.000Z' });
  assert.equal(future.reason, 'seal_issued_in_future');
  const negativeTolerance = verifyMutationReceiptSeal(
    stubStore({ receipt: stubReceipt('h1'), seal: stubSeal('h1') }), 'op:stub',
    { verifySeal, evidenceAt: '2026-08-19T10:00:01.000Z', toleranceMs: -5 });
  assert.equal(negativeTolerance.ok, true);
  const noEvidenceAt = verifyMutationReceiptSeal(
    stubStore({ receipt: stubReceipt('h1'), seal: stubSeal('h1') }), 'op:stub', { verifySeal });
  assert.equal(noEvidenceAt.ok, true);
  assert.ok(noEvidenceAt.evidenceAt);
});
