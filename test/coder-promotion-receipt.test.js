'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { hashCanonicalPayload } = require('../lib/hash-chain');
const { createExperienceJournal } = require('../lib/experience/journal');
const { readSealedRun } = require('../lib/experience/learning-intake');
const { compile } = require('../lib/experience/compiler');
const { DECISION_VERSION, OUTCOME_ATTESTATION_VERSION, signDecision, signOutcomeAttestation } = require('../lib/authority/decision-envelope');
const { buildApprovalDecisionAttestation } = require('../lib/authority/decision-attestation');
const { buildCoderPromotionReceipt, verifyCoderPromotionReceipt, persistCoderPromotionReceipt,
  readCoderPromotionReceipt } = require('../lib/experience/coder-promotion-receipt');

function fixture(journal = createExperienceJournal()) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  for (const [eventId, type] of [['source-start', 'run_started'], ['source-close', 'run_closed']]) {
    assert.equal(journal.append({ runId: 'native-source', workspaceId: 'ws', eventId, type }).ok, true);
  }
  const procedure = value => compile({ candidate: { status: 'candidate', trace: {
    sources: [{ runId: 'native-source', sourceHash: readSealedRun(journal, 'native-source', 'ws').sourceHash }],
    scope: { workspaceId: 'ws' }, revision: 'fixture' } }, kind: value.kind, params: value.params,
  parentVersion: value.version - 1 }).procedure;
  const nextProcedure = procedure({ kind: 'replace_text', version: 2, params: { oldText: 'a', newText: 'b', path: 'a.txt' } });
  const receipt = buildCoderPromotionReceipt({ approvalId: 'approval', workspaceId: 'ws', actionHash: 'a'.repeat(64),
    capabilityId: 'replace', inputArtifactDigests: { candidate: 'b'.repeat(64) },
    previousProcedure: procedure({ kind: 'replace_text', version: 1, params: { oldText: 'a', newText: 'c', path: 'a.txt' } }),
    nextProcedure, sourceRunHashes: [{ runId: 'native-source', sourceHash: readSealedRun(journal, 'native-source', 'ws').sourceHash }],
    qualification: { ok: true, qualified: true, procedureHash: nextProcedure.hash }, outcome: 'promoted' });
  const decisionEnvelope = signDecision({ v: DECISION_VERSION, approvalId: receipt.approvalId, workspaceId: 'ws', tool: 'terfi',
    actionHash: receipt.actionHash, decision: 'approved', reason: '', decidedAt: '2026-01-01T00:00:00.000Z',
    validUntil: '2026-01-01T00:10:00.000Z', ledgerSeq: 1, ledgerHash: 'c'.repeat(64), operator: 'totp:primary', operatorId: 'operator' }, privateKey);
  const sign = (r, status = 'executed') => {
    const outcomeAttestation = signOutcomeAttestation({ v: OUTCOME_ATTESTATION_VERSION, approvalId: 'approval', workspaceId: 'ws',
      tool: 'terfi', actionHash: receipt.actionHash, decision: 'approved', operatorId: 'operator',
      decisionEnvelopeHash: hashCanonicalPayload(decisionEnvelope), status, receiptId: r.receiptId,
      receiptHash: r.receiptHash, recordedAt: '2026-01-01T00:01:00.000Z', ledgerSeq: 2, ledgerHash: 'd'.repeat(64) }, privateKey);
    return buildApprovalDecisionAttestation({ decisionEnvelope, outcomeAttestation }, r, { publicKey });
  };
  return { journal, receipt, publicKey, decisionAttestation: sign(receipt), sign };
}

test('signed receipt persists separately, reads historically and retries without modifying native source', () => {
  const f = fixture();
  const before = f.journal.read('native-source');
  assert.equal(persistCoderPromotionReceipt(f).ok, true);
  assert.equal(persistCoderPromotionReceipt(f).duplicate, true);
  const read = readCoderPromotionReceipt({ ...f, approvalId: 'approval', workspaceId: 'ws' });
  assert.equal(read.ok, true);
  assert.equal(read.authorityVerified, true);
  assert.equal(read.trusted, false);
  assert.deepEqual(read.receipt, f.receipt);
  assert.deepEqual(f.journal.read('native-source'), before);
  assert.equal(f.journal.manifest(f.receipt.receiptId).learningEligibility, 'ineligible');
});

test('accepts 33 sealed sources including the primary and refuses 34', () => {
  const f = fixture();
  const sources = [...f.receipt.sourceRunHashes];
  for (let index = 0; index < 33; index += 1) {
    const runId = `baseline-${index}`;
    for (const [eventId, type] of [['start', 'run_started'], ['close', 'run_closed']]) {
      assert.equal(f.journal.append({ runId, eventId, type, workspaceId: 'ws' }).ok, true);
    }
    sources.push({ runId, sourceHash: readSealedRun(f.journal, runId, 'ws').sourceHash });
  }
  const receipt = buildCoderPromotionReceipt({ ...f.receipt, sourceRunHashes: sources.slice(0, 33) });
  assert.equal(persistCoderPromotionReceipt({ ...f, receipt, decisionAttestation: f.sign(receipt) }).ok, true);
  assert.equal(readCoderPromotionReceipt({ ...f, approvalId: 'approval', workspaceId: 'ws' }).receipt.sourceRunHashes.length, 33);
  assert.throws(() => buildCoderPromotionReceipt({ ...f.receipt, sourceRunHashes: sources }), /invalid coder promotion receipt/);
});

test('altered receipt, signature, pin, expected binding and failed outcome refuse', () => {
  const f = fixture();
  for (const field of ['capabilityId', 'actionHash', 'workspaceId', 'outcome', 'inputArtifactDigests', 'previousProcedure', 'nextProcedure', 'qualification', 'sourceRunHashes']) {
    const receipt = JSON.parse(JSON.stringify(f.receipt));
    receipt[field] = 'changed';
    assert.equal(verifyCoderPromotionReceipt({ ...f, receipt }).ok, false, field);
  }
  const changed = buildCoderPromotionReceipt({ ...f.receipt, capabilityId: 'other' });
  assert.equal(verifyCoderPromotionReceipt({ ...f, receipt: changed }).ok, false);
  assert.equal(verifyCoderPromotionReceipt({ ...f, publicKey: crypto.generateKeyPairSync('ed25519').publicKey }).ok, false);
  assert.equal(verifyCoderPromotionReceipt({ ...f, expected: { capabilityId: 'other' } }).ok, false);
  assert.equal(verifyCoderPromotionReceipt({ ...f, decisionAttestation: f.sign(f.receipt, 'failed') }).ok, false);
  const sidecar = JSON.parse(JSON.stringify(f.decisionAttestation));
  sidecar.outcomeAttestation.payload.receiptHash = changed.receiptHash;
  assert.equal(verifyCoderPromotionReceipt({ ...f, decisionAttestation: sidecar }).ok, false);
  assert.equal(verifyCoderPromotionReceipt({ ...f, decisionAttestation: null }).ok, false);
});

test('a partial append survives SQLite reopen and completes without executing promotion', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-promotion-'));
  const file = path.join(dir, 'journal.db');
  let db = new Database(file);
  const openJournal = () => createExperienceJournal({ store: { db, withTransaction: fn => db.transaction(fn)() } });
  try {
    const f = fixture(openJournal());
    let count = 0;
    const interrupted = { ...f.journal, append(event) {
      count += 1;
      return count === 2 ? { ok: false, code: 'persist_failed' } : f.journal.append(event);
    } };
    assert.deepEqual(persistCoderPromotionReceipt({ ...f, journal: interrupted }), { ok: false, code: 'persist_failed', trusted: false });
    db.close();
    db = new Database(file);
    const journal = openJournal();
    assert.equal(readCoderPromotionReceipt({ ...f, journal, approvalId: 'approval', workspaceId: 'ws' }).code, 'promotion_receipt_incomplete');
    const changed = buildCoderPromotionReceipt({ ...f.receipt, capabilityId: 'other' });
    assert.equal(persistCoderPromotionReceipt({ ...f, journal, receipt: changed, decisionAttestation: f.sign(changed) }).code, 'promotion_receipt_conflict');
    assert.equal(persistCoderPromotionReceipt({ ...f, journal }).ok, true);
    db.close();
    db = new Database(file);
    assert.equal(readCoderPromotionReceipt({ ...f, journal: openJournal(), approvalId: 'approval', workspaceId: 'ws' }).ok, true);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('sealed source mismatch and unclosed source are refused despite valid authority signatures', () => {
  const f = fixture();
  const receipt = buildCoderPromotionReceipt({ ...f.receipt, sourceRunHashes: [{ runId: 'native-source', sourceHash: '0'.repeat(64) }] });
  assert.equal(persistCoderPromotionReceipt({ ...f, receipt, decisionAttestation: f.sign(receipt) }).code, 'promotion_source_hash_mismatch');
  assert.equal(f.journal.append({ runId: 'unfinished', eventId: 'start', workspaceId: 'ws', type: 'run_started' }).ok, true);
  const incomplete = buildCoderPromotionReceipt({ ...f.receipt, sourceRunHashes: [{ runId: 'unfinished', sourceHash: '0'.repeat(64) }] });
  assert.equal(persistCoderPromotionReceipt({ ...f, receipt: incomplete, decisionAttestation: f.sign(incomplete) }).code, 'run_not_sealed');
});

test('rollback receipts recover every interrupted tail and never accept an unrelated closing event', () => {
  for (const stopAt of [1, 2, 3]) {
    const f = fixture();
    const receipt = buildCoderPromotionReceipt({ ...f.receipt, outcome: 'rolled_back' });
    const decisionAttestation = f.sign(receipt);
    let calls = 0;
    const interrupted = { ...f.journal, append(event) {
      return ++calls === stopAt ? { ok: false, code: 'persist_failed' } : f.journal.append(event);
    } };
    assert.equal(persistCoderPromotionReceipt({ ...f, receipt, decisionAttestation, journal: interrupted }).ok, false);
    assert.equal(persistCoderPromotionReceipt({ ...f, receipt, decisionAttestation }).ok, true);
    assert.equal(readCoderPromotionReceipt({ ...f, approvalId: 'approval', workspaceId: 'ws' }).receipt.outcome, 'rolled_back');
  }
  const f = fixture();
  assert.equal(f.journal.append({ runId: f.receipt.receiptId, eventId: 'unrelated', type: 'run_closed', workspaceId: 'ws' }).ok, true);
  assert.equal(persistCoderPromotionReceipt(f).code, 'promotion_receipt_conflict');
  assert.equal(readCoderPromotionReceipt({ ...f, approvalId: 'approval', workspaceId: 'ws' }).ok, false);
});
