'use strict';

const crypto = require('node:crypto');
const { stableStringify } = require('../hash-chain');
const {
  OUTCOME_ATTESTATION_VERSION,
  verifyDecision,
  verifyOutcomeAttestation,
} = require('./decision-envelope');

const APPROVAL_DECISION_ATTESTATION_SCHEMA = 'huqan.approval-decision-attestation.v1';
const ATTESTATION_FIELDS = Object.freeze(['schemaVersion', 'decisionEnvelope', 'outcomeAttestation']);

function digest(value) {
  return crypto.createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

function expectedReceiptHash(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return null;
  if (typeof receipt.receiptHash === 'string' && /^[0-9a-f]{64}$/.test(receipt.receiptHash)) {
    return receipt.receiptHash;
  }
  if (typeof receipt.receiptId !== 'string' || !receipt.receiptId.trim()) return null;
  return digest(receipt);
}

/**
 * The sidecar joins two immutable statements:
 * - the Authority-signed decision envelope (including operator identity);
 * - the Authority-signed outcome that binds the exact execution receipt hash.
 *
 * The receipt itself is not mutated, so its existing signature/hash format
 * remains intact. This module is owned by AgentAction because it verifies
 * Authority protocol evidence; callers inject storage/runtime dependencies.
 */
function buildApprovalDecisionAttestation({ decisionEnvelope, outcomeAttestation } = {}, receipt, options = {}) {
  if (typeof decisionEnvelope?.payload?.operatorId !== 'string'
      || !decisionEnvelope.payload.operatorId.trim()) return null;
  const attestation = {
    schemaVersion: APPROVAL_DECISION_ATTESTATION_SCHEMA,
    decisionEnvelope,
    outcomeAttestation,
  };
  const verified = verifyApprovalDecisionAttestation(attestation, { ...options, receipt });
  if (!verified.ok) throw new TypeError(`approval decision attestation refused: ${verified.code}`);
  return Object.freeze(attestation);
}

/**
 * Verify both Authority signatures and their join to one untouched receipt.
 * The decision is checked at its signed decision time so historical evidence
 * stays verifiable after the decision validity window has elapsed.
 */
function verifyApprovalDecisionAttestation(attestation, {
  publicKey, receipt, expected = {}, expectedOutcomeStatus,
} = {}) {
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) {
    return { ok: false, code: 'ATTESTATION_MALFORMED' };
  }
  if (Object.keys(attestation).length !== ATTESTATION_FIELDS.length
      || ATTESTATION_FIELDS.some(field => !Object.hasOwn(attestation, field))) {
    return { ok: false, code: 'ATTESTATION_FIELDS_INVALID' };
  }
  if (attestation.schemaVersion !== APPROVAL_DECISION_ATTESTATION_SCHEMA) {
    return { ok: false, code: 'ATTESTATION_VERSION_UNSUPPORTED' };
  }

  const decisionEnvelope = attestation.decisionEnvelope;
  const outcomeAttestation = attestation.outcomeAttestation;
  const decisionPayload = decisionEnvelope?.payload;
  const outcomePayload = outcomeAttestation?.payload;
  if (!decisionPayload || typeof decisionPayload !== 'object'
      || !outcomePayload || typeof outcomePayload !== 'object') {
    return { ok: false, code: 'ATTESTATION_PAYLOAD_MISSING' };
  }
  if (typeof decisionPayload.operatorId !== 'string' || !decisionPayload.operatorId.trim()) {
    return { ok: false, code: 'ATTESTATION_OPERATOR_ID_MISSING' };
  }

  const issuedAt = Date.parse(decisionPayload.decidedAt);
  if (!Number.isFinite(issuedAt)) return { ok: false, code: 'DECISION_TIME_INVALID' };
  const decisionExpected = {
    approvalId: decisionPayload.approvalId,
    workspaceId: decisionPayload.workspaceId,
    tool: decisionPayload.tool,
    actionHash: decisionPayload.actionHash,
    decision: decisionPayload.decision,
  };
  for (const field of Object.keys(decisionExpected)) {
    if (Object.hasOwn(expected, field) && expected[field] !== decisionExpected[field]) {
      return { ok: false, code: 'ATTESTATION_EXPECTED_BINDING_MISMATCH', field };
    }
  }

  let verifiedDecision;
  try {
    verifiedDecision = verifyDecision(decisionEnvelope, {
      publicKey,
      expected: decisionExpected,
      now: issuedAt,
    });
  } catch {
    verifiedDecision = { ok: false, code: 'malformed' };
  }
  if (!verifiedDecision.ok) {
    return { ok: false, code: `AUTHORITY_DECISION_${verifiedDecision.code.toUpperCase()}` };
  }

  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return { ok: false, code: 'EXECUTION_RECEIPT_MISSING' };
  }
  for (const field of ['approvalId', 'workspaceId', 'tool', 'actionHash']) {
    if (receipt[field] !== undefined && receipt[field] !== null && receipt[field] !== ''
        && receipt[field] !== decisionExpected[field]) {
      return { ok: false, code: 'EXECUTION_RECEIPT_BINDING_MISMATCH', field };
    }
  }
  const receiptHash = expectedReceiptHash(receipt);
  if (!receiptHash) return { ok: false, code: 'EXECUTION_RECEIPT_HASH_UNAVAILABLE' };

  const expectedOutcome = {
    v: OUTCOME_ATTESTATION_VERSION,
    approvalId: decisionPayload.approvalId,
    workspaceId: decisionPayload.workspaceId,
    tool: decisionPayload.tool,
    actionHash: decisionPayload.actionHash,
    decision: decisionPayload.decision,
    operatorId: decisionPayload.operatorId || null,
    decisionEnvelopeHash: digest(decisionEnvelope),
    ...(expectedOutcomeStatus ? { status: expectedOutcomeStatus } : {}),
  };
  let verifiedOutcome;
  try {
    verifiedOutcome = verifyOutcomeAttestation(outcomeAttestation, {
      publicKey, expected: expectedOutcome,
    });
  } catch {
    verifiedOutcome = { ok: false, code: 'malformed' };
  }
  if (!verifiedOutcome.ok) {
    return { ok: false, code: `AUTHORITY_OUTCOME_${verifiedOutcome.code.toUpperCase()}` };
  }
  if (receipt.receiptId !== verifiedOutcome.payload.receiptId
      || receiptHash !== verifiedOutcome.payload.receiptHash) {
    return { ok: false, code: 'EXECUTION_RECEIPT_HASH_MISMATCH' };
  }
  if (decisionPayload.operatorId !== verifiedOutcome.payload.operatorId
      || decisionPayload.approvalId !== verifiedOutcome.payload.approvalId
      || decisionPayload.workspaceId !== verifiedOutcome.payload.workspaceId
      || decisionPayload.tool !== verifiedOutcome.payload.tool
      || decisionPayload.actionHash !== verifiedOutcome.payload.actionHash
      || decisionPayload.decision !== verifiedOutcome.payload.decision) {
    return { ok: false, code: 'ATTESTATION_BINDING_MISMATCH' };
  }
  return {
    ok: true, decision: verifiedDecision.payload, outcome: verifiedOutcome.payload, attestation,
  };
}

async function persistAuthorityOutcomeAndAttestation({
  client, approvalId, decisionEnvelope, result, consumeProof, publicKey, runtime, workspaceId,
}) {
  const receipt = result?.ok === true && result.data && typeof result.data.receipt === 'object'
    ? result.data.receipt
    : null;
  const receiptId = receipt && typeof receipt.receiptId === 'string' && receipt.receiptId
    ? receipt.receiptId.slice(0, 256)
    : String(result?.ok ? approvalId : result?.error?.code || 'failed').slice(0, 256);

  let recorded;
  try {
    recorded = await client.recordOutcome(approvalId, {
      status: result?.ok === true ? 'executed' : 'failed',
      receiptId,
      receiptHash: expectedReceiptHash(receipt),
      consumeProof,
    });
  } catch (error) {
    return {
      ok: false, outcomeRecorded: false,
      error: error?.code || error?.name || 'AUTHORITY_UNAVAILABLE',
      note: 'The action may already have run. Do not apply again before checking the recorded outcome.',
    };
  }
  if (recorded?.status !== 200 || !recorded.body?.attestation) {
    return {
      ok: false, outcomeRecorded: false,
      error: recorded?.body?.code || `HTTP_${recorded?.status || 0}`,
      note: 'The action may already have run. Do not apply again before checking the recorded outcome.',
    };
  }
  if (result?.ok !== true) {
    return { ok: false, outcomeRecorded: true, error: result?.error?.code || 'EXECUTION_FAILED' };
  }
  if (!receipt) {
    return {
      ok: false, outcomeRecorded: true, error: 'EXECUTION_RECEIPT_MISSING',
      note: 'The action ran, but no canonical receipt was returned; do not re-run it while reconciling evidence.',
    };
  }

  let decisionAttestation;
  try {
    decisionAttestation = buildApprovalDecisionAttestation({
      decisionEnvelope, outcomeAttestation: recorded.body.attestation,
    }, receipt, { publicKey });
  } catch (error) {
    return {
      ok: false, outcomeRecorded: true,
      error: error?.code || error?.name || 'ATTESTATION_INVALID',
      note: 'The action ran and its outcome was recorded, but the portable receipt attestation could not be verified.',
    };
  }
  if (!decisionAttestation) {
    return {
      ok: true, outcomeRecorded: true, decisionAttestationStored: false,
      identityStatus: 'operator_id_not_configured',
    };
  }
  if (typeof runtime?.approvalStore?.attachApprovalDecisionAttestation !== 'function') {
    return {
      ok: false, outcomeRecorded: true, decisionAttestationStored: false,
      error: 'DECISION_ATTESTATION_STORAGE_UNAVAILABLE',
      note: 'The action ran and its outcome was recorded; the attestation was verified but not persisted with the local approval.',
    };
  }

  let attached;
  try {
    attached = runtime.approvalStore.attachApprovalDecisionAttestation(approvalId, {
      workspaceId, decisionAttestation,
    });
  } catch (error) {
    return {
      ok: false, outcomeRecorded: true, decisionAttestationStored: false,
      error: error?.code || error?.name || 'DECISION_ATTESTATION_STORAGE_FAILED',
      note: 'The action ran and its outcome was recorded; do not re-run it while receipt evidence is reconciled.',
    };
  }
  if (!attached?.attached) {
    return {
      ok: false, outcomeRecorded: true, decisionAttestationStored: false,
      error: attached?.reason || 'DECISION_ATTESTATION_STORAGE_FAILED',
      note: 'The action ran and its outcome was recorded; do not re-run it while receipt evidence is reconciled.',
    };
  }
  return { ok: true, outcomeRecorded: true, decisionAttestationStored: true };
}

async function recoverFinalApprovalAttestation({
  client, approvalId, decisionEnvelope, receipt, consumeProof, publicKey, runtime, workspaceId,
}) {
  const result = await persistAuthorityOutcomeAndAttestation({
    client, approvalId, decisionEnvelope,
    result: { ok: true, data: { receipt, executed: true } },
    consumeProof, publicKey, runtime, workspaceId,
  });
  return {
    code: result.ok ? 0 : 2,
    report: {
      approvalId,
      decision: decisionEnvelope?.payload?.decision || 'approved',
      alreadyFinal: 'approved',
      ...(result.ok ? {
        outcomeRecorded: result.outcomeRecorded,
        decisionAttestationStored: result.decisionAttestationStored,
        ...(result.identityStatus ? { identityStatus: result.identityStatus } : {}),
        ...(result.decisionAttestationStored ? { attestationRecovered: true } : {}),
      } : {
        recoveryError: result.error || 'ATTESTATION_RECOVERY_FAILED',
        note: result.note || 'The action was not rerun; receipt attestation recovery can be retried.',
      }),
    },
  };
}

module.exports = {
  APPROVAL_DECISION_ATTESTATION_SCHEMA,
  expectedReceiptHash,
  buildApprovalDecisionAttestation,
  verifyApprovalDecisionAttestation,
  persistAuthorityOutcomeAndAttestation,
  recoverFinalApprovalAttestation,
};
