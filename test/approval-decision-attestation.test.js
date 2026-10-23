'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { stableStringify } = require('../lib/hash-chain');
const {
  DECISION_VERSION,
  OUTCOME_ATTESTATION_VERSION,
  signDecision,
  signOutcomeAttestation,
} = require('../lib/authority/decision-envelope');
const {
  buildApprovalDecisionAttestation,
  verifyApprovalDecisionAttestation,
  persistAuthorityOutcomeAndAttestation,
} = require('../lib/authority/decision-attestation');

const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const binding = Object.freeze({
  approvalId: 'apr_attestation_1',
  workspaceId: 'workspace-a',
  tool: 'huqan.agent',
  actionHash: 'a'.repeat(64),
  decision: 'approved',
});
const receipt = Object.freeze({
  schemaVersion: 'mcp-agent-approval-execution-v1',
  receiptId: 'receipt_attestation_1',
  approvalId: binding.approvalId,
  workspaceId: binding.workspaceId,
  tool: binding.tool,
  inputHash: 'b'.repeat(64),
  outcome: 'completed',
});
const keys = crypto.generateKeyPairSync('ed25519');

function digest(value) {
  return crypto.createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

function signedEvidence({ operatorId = 'alice', targetReceipt = receipt } = {}) {
  const payload = {
    v: DECISION_VERSION,
    ...binding,
    reason: 'reviewed by operator',
    decidedAt: new Date(NOW).toISOString(),
    validUntil: new Date(NOW + 5 * 60 * 1000).toISOString(),
    ledgerSeq: 4,
    ledgerHash: 'c'.repeat(64),
    operator: 'totp:primary',
    ...(operatorId ? { operatorId } : {}),
  };
  const decisionEnvelope = signDecision(payload, keys.privateKey);
  const receiptHash = targetReceipt.receiptHash || digest(targetReceipt);
  const outcomePayload = {
    v: OUTCOME_ATTESTATION_VERSION,
    approvalId: binding.approvalId,
    workspaceId: binding.workspaceId,
    tool: binding.tool,
    actionHash: binding.actionHash,
    decision: binding.decision,
    operatorId: operatorId || null,
    decisionEnvelopeHash: digest(decisionEnvelope),
    status: 'executed',
    receiptId: targetReceipt.receiptId,
    receiptHash,
    recordedAt: new Date(NOW + 1000).toISOString(),
    ledgerSeq: 7,
    ledgerHash: 'e'.repeat(64),
  };
  return {
    decisionEnvelope,
    outcomeAttestation: signOutcomeAttestation(outcomePayload, keys.privateKey),
  };
}

test('attestation joins two Authority signatures to the original receipt bytes', () => {
  const evidence = signedEvidence();
  const attestation = buildApprovalDecisionAttestation(evidence, receipt, { publicKey: keys.publicKey });

  assert.equal(attestation.schemaVersion, 'huqan.approval-decision-attestation.v1');
  assert.equal(attestation.decisionEnvelope.payload.operatorId, 'alice');
  assert.equal(attestation.outcomeAttestation.payload.receiptId, receipt.receiptId);
  assert.equal(attestation.outcomeAttestation.payload.receiptHash, digest(receipt));

  const verified = verifyApprovalDecisionAttestation(attestation, {
    publicKey: keys.publicKey,
    receipt,
    expected: binding,
    expectedOutcomeStatus: 'executed',
  });
  assert.equal(verified.ok, true, verified.code);
  assert.equal(verified.decision.operatorId, 'alice');
  assert.deepEqual(verified.decision, evidence.decisionEnvelope.payload);
  assert.deepEqual(receipt, {
    schemaVersion: 'mcp-agent-approval-execution-v1',
    receiptId: 'receipt_attestation_1',
    approvalId: binding.approvalId,
    workspaceId: binding.workspaceId,
    tool: binding.tool,
    inputHash: 'b'.repeat(64),
    outcome: 'completed',
  }, 'the receipt is not mutated to add identity');
});

test('editing either signed identity or a receipt byte is refused', () => {
  const attestation = buildApprovalDecisionAttestation(signedEvidence(), receipt, { publicKey: keys.publicKey });
  const forgedDecision = structuredClone(attestation);
  forgedDecision.decisionEnvelope.payload.operatorId = 'mallory';
  assert.notEqual(verifyApprovalDecisionAttestation(forgedDecision, {
    publicKey: keys.publicKey, receipt, expected: binding,
  }).ok, true);

  const changedReceipt = { ...receipt, outcome: 'cancelled' };
  assert.equal(verifyApprovalDecisionAttestation(attestation, {
    publicKey: keys.publicKey, receipt: changedReceipt, expected: binding,
  }).code, 'EXECUTION_RECEIPT_HASH_MISMATCH');

  const forgedOutcome = structuredClone(attestation);
  forgedOutcome.outcomeAttestation.payload.receiptHash = 'f'.repeat(64);
  assert.equal(verifyApprovalDecisionAttestation(forgedOutcome, {
    publicKey: keys.publicKey, receipt, expected: binding,
  }).code, 'AUTHORITY_OUTCOME_SIGNATURE_INVALID');
});

test('a public digest cannot be recomputed to forge the Authority signature or receipt join', () => {
  const attestation = buildApprovalDecisionAttestation(signedEvidence(), receipt, { publicKey: keys.publicKey });
  const forged = structuredClone(attestation);
  forged.outcomeAttestation.payload.decisionEnvelopeHash = digest({
    ...forged.decisionEnvelope,
    payload: { ...forged.decisionEnvelope.payload, operatorId: 'mallory' },
  });
  assert.notEqual(verifyApprovalDecisionAttestation(forged, {
    publicKey: keys.publicKey, receipt, expected: binding,
  }).ok, true);
});

test('a sidecar cannot be constructed from a decision identity missing from the signed envelope', () => {
  const evidence = signedEvidence();
  const forged = {
    decisionEnvelope: evidence.decisionEnvelope,
    outcomeAttestation: evidence.outcomeAttestation,
  };
  forged.decisionEnvelope = signDecision({
    ...evidence.decisionEnvelope.payload,
    operatorId: 'mallory',
  }, keys.privateKey);
  assert.throws(() => buildApprovalDecisionAttestation(forged, receipt, { publicKey: keys.publicKey }), /refused/);
});

test('legacy envelopes without person-level operatorId do not claim a named approver', () => {
  const evidence = signedEvidence({ operatorId: null });
  assert.equal(buildApprovalDecisionAttestation(evidence, receipt, { publicKey: keys.publicKey }), null);
});


test('authority outcome is persisted and the verified sidecar is attached without changing the receipt', async () => {
  const evidence = signedEvidence();
  const calls = [];
  let stored;
  const client = {
    async recordOutcome(approvalId, outcome) {
      calls.push({ approvalId, outcome });
      return { status: 200, body: { attestation: evidence.outcomeAttestation } };
    },
  };
  const runtime = {
    approvalStore: {
      attachApprovalDecisionAttestation(approvalId, input) {
        stored = { approvalId, ...input };
        return { attached: true };
      },
    },
  };

  const result = await persistAuthorityOutcomeAndAttestation({
    client, approvalId: binding.approvalId, decisionEnvelope: evidence.decisionEnvelope,
    result: { ok: true, data: { receipt, executed: true } },
    consumeProof: 'runtime-only-proof', publicKey: keys.publicKey, runtime, workspaceId: binding.workspaceId,
  });

  assert.deepEqual(result, { ok: true, outcomeRecorded: true, decisionAttestationStored: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].approvalId, binding.approvalId);
  assert.equal(calls[0].outcome.status, 'executed');
  assert.equal(calls[0].outcome.receiptId, receipt.receiptId);
  assert.equal(calls[0].outcome.receiptHash, digest(receipt));
  assert.equal(calls[0].outcome.consumeProof, 'runtime-only-proof');
  assert.equal(stored.approvalId, binding.approvalId);
  assert.equal(verifyApprovalDecisionAttestation(stored.decisionAttestation, {
    publicKey: keys.publicKey, receipt, expected: binding, expectedOutcomeStatus: 'executed',
  }).ok, true);
});

test('an outcome retry can recover the same sidecar after a lost client response', async () => {
  const evidence = signedEvidence();
  let stored = null;
  let calls = 0;
  const result = await persistAuthorityOutcomeAndAttestation({
    client: { async recordOutcome() { calls += 1; return { status: 200, body: { attestation: evidence.outcomeAttestation, duplicate: true } }; } },
    approvalId: binding.approvalId, decisionEnvelope: evidence.decisionEnvelope,
    result: { ok: true, data: { receipt, executed: true } },
    consumeProof: 'runtime-only-proof', publicKey: keys.publicKey,
    workspaceId: binding.workspaceId,
    runtime: { approvalStore: { attachApprovalDecisionAttestation(_id, input) { stored = input.decisionAttestation; return { attached: true }; } } },
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  assert.equal(stored.outcomeAttestation.payload.receiptId, receipt.receiptId);
});

test('outcome recording failures warn that execution may already have happened', async () => {
  let attached = false;
  const result = await persistAuthorityOutcomeAndAttestation({
    client: { async recordOutcome() { throw Object.assign(new Error('disconnected'), { code: 'ECONNRESET' }); } },
    approvalId: binding.approvalId, decisionEnvelope: signedEvidence().decisionEnvelope,
    result: { ok: true, data: { receipt, executed: true } },
    consumeProof: 'runtime-only-proof', publicKey: keys.publicKey, workspaceId: binding.workspaceId,
    runtime: { approvalStore: { attachApprovalDecisionAttestation() { attached = true; return { attached: true }; } } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.outcomeRecorded, false);
  assert.equal(result.error, 'ECONNRESET');
  assert.match(result.note, /Do not apply again/);
  assert.equal(attached, false);
});

test('legacy signed decisions keep single-user behaviour without an invented person identity', async () => {
  const evidence = signedEvidence({ operatorId: null });
  let attached = false;
  const result = await persistAuthorityOutcomeAndAttestation({
    client: { async recordOutcome() { return { status: 200, body: { attestation: evidence.outcomeAttestation } }; } },
    approvalId: binding.approvalId, decisionEnvelope: evidence.decisionEnvelope,
    result: { ok: true, data: { receipt, executed: true } },
    consumeProof: 'runtime-only-proof', publicKey: keys.publicKey, workspaceId: binding.workspaceId,
    runtime: { approvalStore: { attachApprovalDecisionAttestation() { attached = true; return { attached: true }; } } },
  });
  assert.deepEqual(result, {
    ok: true, outcomeRecorded: true, decisionAttestationStored: false,
    identityStatus: 'operator_id_not_configured',
  });
  assert.equal(attached, false);
});


test('a signed outcome cannot associate another workspace receipt with the decision', () => {
  const foreignReceipt = { ...receipt, workspaceId: 'workspace-b' };
  const evidence = signedEvidence({ targetReceipt: foreignReceipt });
  assert.throws(() => buildApprovalDecisionAttestation(evidence, foreignReceipt, {
    publicKey: keys.publicKey,
  }), /EXECUTION_RECEIPT_BINDING_MISMATCH/);
});
