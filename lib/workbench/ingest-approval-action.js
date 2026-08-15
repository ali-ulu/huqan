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

function apiError(status, code, message) {
  return { status, error: { code, message } };
}

// Bounded, non-identifying Graph evidence. Raw rows never leave this function.
function captureGraphEvidence(kernel) {
  try {
    const stats = kernel.graph.getStats();
    const nodes = Number(stats.nodes);
    const edges = Number(stats.edges);
    // Bounded count (#728). getAuditEvents({}).length materialized, parsed,
    // cloned and sorted the entire audit history on both sides of every
    // approval, making a small approval cost O(total audit history).
    //
    // Scope stays deliberately global here, matching getStats() above: this
    // evidence pair is a whole-graph before/after delta, and narrowing only
    // one of its three counters to a workspace would make the comparison
    // inconsistent with itself.
    const auditCount = typeof kernel.graph.countAuditEvents === 'function'
      ? kernel.graph.countAuditEvents({})
      : kernel.graph.getAuditEvents({}).length;
    if (!Number.isFinite(nodes) || !Number.isFinite(edges) || !Number.isFinite(auditCount)) {
      return { ok: false };
    }
    return { ok: true, nodes, edges, auditCount };
  } catch (_) {
    return { ok: false };
  }
}

function evidenceRef(evidence) {
  if (!evidence.ok) return '';
  return sha256({ nodes: evidence.nodes, edges: evidence.edges, auditCount: evidence.auditCount });
}

// Derives a truthful outcome from the returned admission summary AND the
// observed Graph delta. Observed evidence is authoritative: an `allow` that did
// not move the Graph is reported as no-write-observed, not as a write.
function classifyActionOutcome(result, before, after) {
  if (!before.ok || !after.ok) return { outcome: OUTCOME_UNKNOWN, reason: 'graph_evidence_unavailable' };
  if (!result || typeof result !== 'object' || Array.isArray(result) || result.ok !== true) {
    return { outcome: OUTCOME_UNKNOWN, reason: 'result_not_ok' };
  }

  const admission = result.admission;
  if (!admission || typeof admission !== 'object' || Array.isArray(admission)) {
    return { outcome: OUTCOME_UNKNOWN, reason: 'admission_summary_missing' };
  }

  const nodeDelta = after.nodes - before.nodes;
  const edgeDelta = after.edges - before.edges;
  if (nodeDelta < 0 || edgeDelta < 0) return { outcome: OUTCOME_UNKNOWN, reason: 'graph_evidence_regressed' };
  const observedWrite = nodeDelta > 0 || edgeDelta > 0;

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

function safeAudit(recordAudit, approval, receipt, result) {
  try {
    return recordAudit(approval, receipt, result).auditId || '';
  } catch (error) {
    console.error('[ingest-approval-audit] failed:', error);
    return '';
  }
}

function rejectIngestApproval({ store, approval, snapshot, recordAudit, toPublicApproval }) {
  const receipt = buildBlockedActionReceipt(
    decisionBase(approval.id, snapshot.workspaceId, 'http_ingest_rejected'),
    { metadata: receiptMetadata(snapshot, { actionOutcome: 'not_executed' }) },
  );
  const rejected = store.finalizeToolApprovalWithReceipt(approval.id, {
    expectedStatus: 'pending', decision: 'rejected', reason: 'http_ingest_rejected', receipt,
  });
  if (!rejected.finalized) {
    return apiError(409, 'APPROVAL_DECISION_CONFLICT', 'Approval is no longer pending.');
  }
  const auditRef = safeAudit(recordAudit, rejected.approval, receipt, null);
  return { status: 200, json: { ok: true, approval: toPublicApproval(rejected.approval), receipt, auditRef } };
}

async function executeApprovedIngest(deps) {
  const { store, kernel, approval, handleIngest, ensureRuntime } = deps;
  const { recordAudit, toPublicApproval, workerId, leaseMs } = deps;

  // Claim first: `failToolApproval` only transitions an executing row, so the
  // durable claim must exist before any rejection can be persisted.
  const claim = store.claimToolApprovalWithLease(approval.id, {
    owner: workerId, leaseMs, reason: 'http_ingest_execution_claimed',
  });
  if (!claim.claimed) {
    return apiError(409, 'APPROVAL_EXECUTION_IN_PROGRESS', 'Approval is already claimed or not pending.');
  }

  const snapshot = claim.approval.context?.snapshot;
  const verified = verifyIngestApprovalSnapshot(snapshot);
  if (!verified.ok) {
    store.failToolApproval(approval.id, `${OUTCOME_UNKNOWN}:${verified.code.toLowerCase()}`);
    return apiError(409, 'SNAPSHOT_INTEGRITY_MISMATCH', 'Queued ingest snapshot no longer validates.');
  }

  let leaseLost = false;
  const heartbeat = setInterval(() => {
    try {
      if (!store.renewToolApprovalLease(approval.id, workerId, leaseMs).renewed) leaseLost = true;
    } catch (_) {
      leaseLost = true;
    }
  }, Math.max(5_000, Math.floor(leaseMs / 2)));
  heartbeat.unref?.();

  const before = captureGraphEvidence(kernel);
  let result = null;
  let threw = false;
  try {
    result = await handleIngest({ kernel, data: snapshot.payload, ensureRuntime });
  } catch (error) {
    // The raw plugin error never reaches the caller; only a bounded code does.
    console.error('[ingest-approval-execution] failed:', error);
    threw = true;
  } finally {
    clearInterval(heartbeat);
  }
  const after = captureGraphEvidence(kernel);

  const classified = threw
    ? { outcome: OUTCOME_UNKNOWN, reason: 'execution_threw' }
    : classifyActionOutcome(result, before, after);

  if (leaseLost) {
    store.failToolApproval(approval.id, `${OUTCOME_UNKNOWN}:lease_lost`);
    return apiError(409, 'APPROVAL_LEASE_LOST', 'Ingest execution returned after its approval lease was lost; manual reconciliation is required.');
  }
  if (classified.outcome === OUTCOME_UNKNOWN) {
    store.failToolApproval(approval.id, `${OUTCOME_UNKNOWN}:${classified.reason}`);
    return apiError(409, 'INGEST_EXECUTION_UNKNOWN', 'Approved ingest did not produce a bounded outcome; manual reconciliation is required.');
  }

  const receipt = buildReviewedActionReceipt(
    decisionBase(approval.id, snapshot.workspaceId, 'http_ingest_executed'),
    {
      metadata: receiptMetadata(snapshot, {
        admissionOutcome: result.admission.outcome,
        actionOutcome: classified.outcome,
        pluginResultRef: sha256(result),
        graphEvidenceBeforeRef: evidenceRef(before),
        graphEvidenceAfterRef: evidenceRef(after),
      }),
    },
  );
  receipt.actionExecution = 'ingest_capability_executed';
  receipt.actionOutcome = classified.outcome;

  const finalized = store.finalizeToolApprovalWithReceipt(approval.id, {
    expectedStatus: 'executing', decision: 'approved', reason: 'http_ingest_executed', receipt,
  });
  if (!finalized.finalized) {
    return apiError(409, 'APPROVAL_FINALIZATION_CONFLICT', 'Ingest executed, but approval finalization requires reconciliation.');
  }
  const auditRef = safeAudit(recordAudit, finalized.approval, receipt, result);
  return {
    status: 200,
    json: { ok: true, approval: toPublicApproval(finalized.approval), result, receipt, auditRef },
  };
}

// Single entry point used by server.js. Decision-request bytes select only
// approved|rejected; they never control workspace, snapshot, source, action
// owner, idempotency or receipt meaning.
async function decideIngestApproval(deps) {
  const { store, approvalId, decision, toPublicApproval } = deps;

  const approval = store.getToolApprovalById(approvalId);
  if (!approval || approval.tool !== 'http.ingest') {
    return apiError(404, 'APPROVAL_NOT_FOUND', 'Ingest approval was not found.');
  }
  if (approval.status === 'approved' || approval.status === 'rejected') {
    return { status: 200, json: { ok: true, idempotent: true, approval: toPublicApproval(approval) } };
  }

  if (decision !== 'rejected') return executeApprovedIngest({ ...deps, approval });

  // Rejection finalizes straight from `pending`, so it verifies before writing
  // a receipt. An unverifiable snapshot leaves the row untouched rather than
  // binding a forged workspace into a blocked receipt.
  const snapshot = approval.context?.snapshot;
  const verified = verifyIngestApprovalSnapshot(snapshot);
  if (!verified.ok) {
    return apiError(409, 'SNAPSHOT_INTEGRITY_MISMATCH', 'Queued ingest snapshot no longer validates.');
  }
  return rejectIngestApproval({ ...deps, approval, snapshot });
}

module.exports = {
  ACTION_OWNER,
  ACTION_OWNER_VERSION,
  ACTION_OUTCOMES,
  CANONICAL_INGEST_WORKSPACE_ID,
  OUTCOME_UNKNOWN,
  classifyActionOutcome,
  decideIngestApproval,
  // Exposed so the bounded-count contract (#728) can be asserted directly
  // rather than inferred from a full approval round-trip.
  captureGraphEvidenceForTest: captureGraphEvidence,
};
