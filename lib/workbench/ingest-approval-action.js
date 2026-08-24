'use strict';
// V4-B2B bounded ingest-approval action owner.
//
// PR #267 proved two gaps in the HTTP ingest approval lifecycle: the queued
// snapshot dropped caller workspace identity, and the approval route described
// a generic plugin return as the final action outcome
// (`state_transition_not_asserted`). This module owns the repaired decision and
// execution path so `server.js` stays a thin orchestrator.
//
// Deliberate limits:
//   - it never writes to the Graph itself; the ingest capability performs the
//     write and the audit append is an injected server-owned dependency;
//   - it never imports or calls the reviewed-external graph mutation owner,
//     whose envelope/plan/admission/reservation chain this snapshot does not
//     contain (naming that symbol here is itself asserted against);
//   - an uncertain, malformed or contradictory outcome persists as
//     `execution_outcome_unknown` and is never retried automatically.
const { verifyIngestApprovalSnapshot, CANONICAL_INGEST_WORKSPACE_ID, sha256 } = require('../ingest');
const { buildReviewedActionReceipt, buildBlockedActionReceipt } = require('../approval-flow');
const { auditOrGap } = require('./ingest-approval-audit');
const {
  prepareHttpIngestOversightDecision,
  executeHttpIngestWithOversight,
  httpOversightFailure,
  oversightSummary,
} = require('../http-human-oversight-adapter');
const ACTION_OWNER = 'lib/workbench/ingest-approval-action';
const ACTION_OWNER_VERSION = 'v4-b2b.1';
const ACTOR = 'http-api';
const OUTCOME_UNKNOWN = 'execution_outcome_unknown';
const ACTION_OUTCOMES = Object.freeze([
  'admission_allow_graph_write_observed',
  'admission_allow_no_graph_write_observed',
  'admission_review_no_graph_write_observed',
  'admission_reject_no_graph_write_observed',
  OUTCOME_UNKNOWN,
]);
function apiError(status, code, message, details = {}) {
  return { status, error: { code, message, details } };
}
// Bounded operation evidence. The capability returns only identifiers created
// by its own proposals, so unrelated graph traffic cannot become this action's
// proof. Raw audit rows and graph objects never cross this boundary.
function captureOperationEvidence(result, approvalId, workspaceId) {
  const raw = Array.isArray(result?.admission?.entries)
    ? result.admission.entries
    : Array.isArray(result?.admission?.evidence) ? result.admission.evidence : null;
  if (!raw || raw.length === 0 || raw.length > 10_000) return { ok: false };
  const entries = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false };
    const itemWorkspaceId = typeof item.workspaceId === 'string' ? item.workspaceId.trim() : '';
    const receiptId = typeof item.receiptId === 'string' ? item.receiptId.trim() : '';
    const auditId = typeof item.auditId === 'string' ? item.auditId.trim() : '';
    if (itemWorkspaceId !== workspaceId || (!receiptId && !auditId) || typeof item.graphWrite !== 'boolean') {
      return { ok: false };
    }
    entries.push({ workspaceId: itemWorkspaceId, receiptId, auditId, graphWrite: item.graphWrite });
  }
  return { ok: true, operationId: approvalId, workspaceId, entries };
}
function evidenceRef(evidence) {
  return evidence.ok ? sha256(evidence) : '';
}
// Derives a truthful outcome from the returned admission summary AND the
// observed Graph delta. Observed evidence is authoritative: an `allow` that did
// not move the Graph is reported as no-write-observed, not as a write.
function classifyActionOutcome(result, evidence) {
  if (!evidence.ok) return { outcome: OUTCOME_UNKNOWN, reason: 'operation_evidence_unavailable' };
  if (!result || typeof result !== 'object' || Array.isArray(result) || result.ok !== true) {
    return { outcome: OUTCOME_UNKNOWN, reason: 'result_not_ok' };
  }
  const admission = result.admission;
  if (!admission || typeof admission !== 'object' || Array.isArray(admission)) {
    return { outcome: OUTCOME_UNKNOWN, reason: 'admission_summary_missing' };
  }
  const observedWrite = evidence.entries.some(entry => entry.graphWrite);
  const declared = admission.outcome;
  if (declared === 'allow') {
    // A write nobody admitted is the alarming direction, so it fails closed.
    if (observedWrite && admission.graphWrite === false) {
      return { outcome: OUTCOME_UNKNOWN, reason: 'observed_write_contradicts_admission' };
    }
    return {
      outcome: observedWrite ? 'admission_allow_graph_write_observed' : 'admission_allow_no_graph_write_observed',
      reason: 'admission_allow',
    };
  }
  if (declared === 'review' || declared === 'reject') {
    if (observedWrite) return { outcome: OUTCOME_UNKNOWN, reason: `admission_${declared}_with_observed_write` };
    return {
      outcome: declared === 'review'
        ? 'admission_review_no_graph_write_observed'
        : 'admission_reject_no_graph_write_observed',
      reason: `admission_${declared}`,
    };
  }
  return { outcome: OUTCOME_UNKNOWN, reason: 'admission_outcome_unrecognized' };
}
function receiptMetadata(snapshot, extra = {}) {
  return {
    reviewer: ACTOR,
    actionOwner: ACTION_OWNER,
    actionOwnerVersion: ACTION_OWNER_VERSION,
    snapshotHash: snapshot.snapshotHash || '',
    idempotencyKey: snapshot.idempotencyKey || '',
    sourceType: snapshot.sourceType || '',
    sourceRef: snapshot.sourceRef || '',
    auditRefs: [],
    ...extra,
  };
}
function decisionBase(approvalId, workspaceId, reason) {
  return {
    approvalId,
    workspaceId,
    actor: ACTOR,
    actionType: 'ingest',
    toolName: 'http.ingest',
    requestedVerdict: 'review',
    reason,
    createdAt: new Date().toISOString(),
  };
}

function rejectIngestApproval({ store, approval, snapshot, workspaceId = 'default', recordAudit, toPublicApproval, oversightDecision }) {
  const receipt = buildBlockedActionReceipt(
    decisionBase(approval.id, snapshot.workspaceId, 'http_ingest_rejected'),
    { metadata: receiptMetadata(snapshot, { actionOutcome: 'not_executed' }) },
  );
  const rejected = store.finalizeToolApprovalWithReceipt(approval.id, {
    expectedStatus: 'pending', decision: 'rejected', reason: 'http_ingest_rejected', workspaceId, receipt,
  });
  if (!rejected.finalized) {
    return apiError(409, 'APPROVAL_DECISION_CONFLICT', 'Approval is no longer pending.');
  }
  const audited = auditOrGap(recordAudit, {
    approval: rejected.approval, receipt, result: null, committed: 'approval_rejected',
    message: 'Ingest approval was rejected, but its audit evidence was not persisted; manual reconciliation is required.',
  });
  if (audited.gap) return audited.gap;
  return { status: 200, json: { ok: true, approval: toPublicApproval(rejected.approval), receipt, auditRef: audited.auditRef, ...(oversightDecision?.enabled ? { oversight: oversightSummary(oversightDecision.case?.result, oversightDecision.result) } : {}) } };
}
async function executeApprovedIngest(deps) {
  const { store, kernel, approval, workspaceId = 'default', handleIngest, ensureRuntime } = deps;
  const { recordAudit, toPublicApproval, workerId, leaseMs } = deps;
  const {
    oversightCase,
    decisionReason = '',
    oversightDecision: precomputedOversightDecision = null,
    identityEvaluation = { enabled: false, ok: true },
  } = deps;
  // Claim first: `failToolApproval` only transitions an executing row, so the
  // durable claim must exist before any rejection can be persisted.
  const claim = store.claimToolApprovalWithLease(approval.id, {
    owner: workerId, leaseMs, workspaceId, reason: 'http_ingest_execution_claimed',
  });
  if (!claim.claimed) {
    return apiError(409, 'APPROVAL_EXECUTION_IN_PROGRESS', 'Approval is already claimed or not pending.');
  }
  const snapshot = claim.approval.context?.snapshot;
  const verified = verifyIngestApprovalSnapshot(snapshot);
  if (!verified.ok) {
    store.failToolApproval(approval.id, `${OUTCOME_UNKNOWN}:${verified.code.toLowerCase()}`, workspaceId);
    return apiError(409, 'SNAPSHOT_INTEGRITY_MISMATCH', 'Queued ingest snapshot no longer validates.');
  }
  const oversightDecision = precomputedOversightDecision || { enabled: false, ok: true };
  if (oversightCase?.enabled && !oversightDecision.ok) {
    store.failToolApproval(approval.id, 'oversight_decision_failed', workspaceId);
    return apiError(409, 'OVERSIGHT_DECISION_FAILED', 'The durable Human Oversight approval could not be recorded; execution is blocked.');
  }
  let leaseLost = false;
  const heartbeat = setInterval(() => {
    try {
      if (!store.renewToolApprovalLease(approval.id, workerId, leaseMs, workspaceId).renewed) leaseLost = true;
    } catch (_) {
      leaseLost = true;
    }
  }, Math.max(5_000, Math.floor(leaseMs / 2)));
  heartbeat.unref?.();
  let result = null;
  let threw = false;
  let oversightExecution = null;
  try {
    const execution = await executeHttpIngestWithOversight({
      oversightCase,
      action: oversightCase?.input?.action,
      requesterContext: oversightCase?.input?.requesterContext,
      firewallRequest: oversightCase?.input?.firewallRequest,
      execute: () => handleIngest({ kernel, data: snapshot.payload, ensureRuntime }),
    });
    oversightExecution = execution.execution;
    result = execution.result;
    if (!execution.ok) {
      store.failToolApproval(approval.id, 'oversight_execution_blocked', workspaceId);
      return apiError(409, execution.failureCode || 'OVERSIGHT_EXECUTION_BLOCKED', 'Human Oversight pre-execution revalidation blocked the ingest.');
    }
  } catch (error) {
    // The raw plugin error never reaches the caller; only a bounded code does.
    console.error('[ingest-approval-execution] failed:', error);
    threw = true;
  } finally {
    clearInterval(heartbeat);
  }
  const operationEvidence = captureOperationEvidence(result, approval.id, snapshot.workspaceId);
  const classified = threw
    ? { outcome: OUTCOME_UNKNOWN, reason: 'execution_threw' }
    : classifyActionOutcome(result, operationEvidence);
  if (leaseLost) {
    store.failToolApproval(approval.id, `${OUTCOME_UNKNOWN}:lease_lost`, workspaceId);
    return apiError(409, 'APPROVAL_LEASE_LOST', 'Ingest execution returned after its approval lease was lost; manual reconciliation is required.');
  }
  if (classified.outcome === OUTCOME_UNKNOWN) {
    store.failToolApproval(approval.id, `${OUTCOME_UNKNOWN}:${classified.reason}`, workspaceId);
    return apiError(409, 'INGEST_EXECUTION_UNKNOWN', 'Approved ingest did not produce a bounded outcome; manual reconciliation is required.');
  }
  const receipt = buildReviewedActionReceipt(
    decisionBase(approval.id, snapshot.workspaceId, 'http_ingest_executed'),
    {
      metadata: receiptMetadata(snapshot, {
        admissionOutcome: result.admission.outcome,
        actionOutcome: classified.outcome,
        pluginResultRef: sha256(result),
        operationId: operationEvidence.operationId,
        operationWorkspaceId: operationEvidence.workspaceId,
        operationEvidenceRef: evidenceRef(operationEvidence),
      }),
    },
  );
  receipt.actionExecution = 'ingest_capability_executed';
  receipt.actionOutcome = classified.outcome;
  const finalized = store.finalizeToolApprovalWithReceipt(approval.id, {
    expectedStatus: 'executing', decision: 'approved', reason: 'http_ingest_executed', workspaceId, receipt,
  });
  if (!finalized.finalized) {
    return apiError(409, 'APPROVAL_FINALIZATION_CONFLICT', 'Ingest executed, but approval finalization requires reconciliation.');
  }
  // The ingest ran and the approval is finalized; if only the evidence is
  // missing, that is a reconciliation state, not a success (#769).
  const audited = auditOrGap(recordAudit, {
    approval: finalized.approval, receipt, result, committed: 'ingest_executed_and_approval_finalized',
    message: 'Approved ingest executed and its approval was finalized, but the audit evidence was not persisted; manual reconciliation is required.',
  });
  if (audited.gap) return audited.gap;
  return { status: 200, json: { ok: true, approval: toPublicApproval(finalized.approval), result, receipt, auditRef: audited.auditRef, ...(oversightCase?.enabled ? { oversight: oversightSummary(oversightCase.result, oversightDecision.result, oversightExecution) } : {}), ...(identityEvaluation?.enabled ? { identity: identityEvaluation.evidence } : {}) } };
}
// Single entry point used by server.js. Decision-request bytes select only
// approved|rejected; they never control workspace, snapshot, source, action
// owner, idempotency or receipt meaning.
async function decideIngestApproval(deps) {
  const { store, approvalId, workspaceId = 'default', decision, reason = '', toPublicApproval, humanOversight = null } = deps;
  const approval = store.getToolApprovalById(approvalId, workspaceId);
  if (!approval || approval.tool !== 'http.ingest') {
    return apiError(404, 'APPROVAL_NOT_FOUND', 'Ingest approval was not found.');
  }
  if (approval.status === 'approved' || approval.status === 'rejected') {
    return { status: 200, json: { ok: true, idempotent: true, approval: toPublicApproval(approval) } };
  }
  const oversightPreparation = prepareHttpIngestOversightDecision({ approval, decision, reason, humanOversight });
  const { oversightCase, oversightDecision } = oversightPreparation;
  if (!oversightPreparation.ok) {
    const failure = httpOversightFailure(oversightPreparation);
    return apiError(failure.status, failure.code, failure.message, failure.details);
  }
  if (decision !== 'rejected') {
    return executeApprovedIngest({ ...deps, approval, workspaceId, oversightCase, decisionReason: reason, oversightDecision, identityEvaluation: oversightPreparation.identityEvaluation });
  }
  // Rejection finalizes straight from `pending`, so it verifies before writing
  // a receipt. An unverifiable snapshot leaves the row untouched rather than
  // binding a forged workspace into a blocked receipt.
  const snapshot = approval.context?.snapshot;
  const verified = verifyIngestApprovalSnapshot(snapshot);
  if (!verified.ok) {
    return apiError(409, 'SNAPSHOT_INTEGRITY_MISMATCH', 'Queued ingest snapshot no longer validates.');
  }
  return rejectIngestApproval({ ...deps, approval, snapshot, workspaceId, oversightDecision });
}
module.exports = {
  ACTION_OWNER,
  ACTION_OWNER_VERSION,
  ACTION_OUTCOMES,
  CANONICAL_INGEST_WORKSPACE_ID,
  OUTCOME_UNKNOWN,
  classifyActionOutcome,
  decideIngestApproval,
  // Exposed for operation/workspace ownership and fail-closed tests.
  captureOperationEvidenceForTest: captureOperationEvidence,
};
