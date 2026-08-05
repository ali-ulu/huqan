'use strict';

const crypto = require('node:crypto');
const { buildReviewedActionReceipt, buildBlockedActionReceipt } = require('../approval-flow');
const { handleIngest, sha256 } = require('../ingest');

const ACTION_OWNER = 'workbench.ingest-approval-action';
const ACTION_OWNER_VERSION = 'v1';
const WORKSPACE_ID = 'default';
const OUTCOMES = Object.freeze({
  ALLOW_WRITE: 'admission_allow_graph_write_observed',
  ALLOW_NO_WRITE: 'admission_allow_no_graph_write_observed',
  REVIEW_NO_WRITE: 'admission_review_no_graph_write_observed',
  REJECT_NO_WRITE: 'admission_reject_no_graph_write_observed',
  UNKNOWN: 'execution_outcome_unknown',
});

function response(statusCode, body) {
  return { statusCode, body };
}

function errorResponse(statusCode, code, message) {
  return response(statusCode, { ok: false, error: { code, message, details: {} } });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function publicIngestApproval(record) {
  if (!record) return null;
  const context = isPlainObject(record.context) ? record.context : {};
  const snapshot = isPlainObject(context.snapshot) ? context.snapshot : {};
  return {
    id: record.id,
    status: record.status,
    decision: record.decision,
    reason: record.reason,
    createdAt: Number(record.created_at || record.createdAt || 0),
    updatedAt: Number(record.updated_at || record.updatedAt || 0),
    snapshotHash: snapshot.snapshotHash || '',
    sourceType: snapshot.sourceType || '',
    sourceRef: snapshot.sourceRef || '',
    idempotencyKey: snapshot.idempotencyKey || '',
    workspaceId: snapshot.payload?.workspaceId || '',
    leaseExpiresAt: Number(context.executionClaim?.leaseExpiresAt || 0),
    receipt: context.receipt || null,
  };
}

function validateSnapshot(approval) {
  const snapshot = approval?.context?.snapshot;
  const payload = snapshot?.payload;
  if (!isPlainObject(snapshot) || !isPlainObject(payload)) return { ok: false, code: 'SNAPSHOT_MISSING' };
  if (!['manual', 'decision'].includes(snapshot.sourceType)) return { ok: false, code: 'SNAPSHOT_SOURCE_TYPE' };
  if (payload.sourceType !== snapshot.sourceType) return { ok: false, code: 'SNAPSHOT_SOURCE_MISMATCH' };
  if (payload.workspaceId !== WORKSPACE_ID) return { ok: false, code: 'SNAPSHOT_WORKSPACE_MISMATCH' };
  if (payload.sourceRef !== snapshot.sourceRef) return { ok: false, code: 'SNAPSHOT_SOURCE_REF_MISMATCH' };
  if (payload.idempotencyKey !== snapshot.idempotencyKey) return { ok: false, code: 'SNAPSHOT_IDEMPOTENCY_MISMATCH' };
  if (sha256(payload) !== snapshot.snapshotHash) return { ok: false, code: 'SNAPSHOT_INTEGRITY_MISMATCH' };
  return { ok: true, snapshot };
}

function graphEvidence(graph) {
  if (!graph || typeof graph.nodeCount !== 'function' || typeof graph.edgeCount !== 'function'
      || typeof graph.getAuditEvents !== 'function') return null;
  const audits = graph.getAuditEvents({ workspaceId: WORKSPACE_ID });
  if (!Array.isArray(audits)) return null;
  const tail = audits.slice(-32).map((event) => ({
    auditId: event.auditId || '',
    eventType: event.eventType || '',
    targetType: event.targetType || '',
    targetId: event.targetId || '',
  }));
  const evidence = {
    workspaceId: WORKSPACE_ID,
    nodes: Number(graph.nodeCount(WORKSPACE_ID)),
    edges: Number(graph.edgeCount(WORKSPACE_ID)),
    audits: audits.length,
    auditTailHash: sha256(tail),
  };
  if (![evidence.nodes, evidence.edges, evidence.audits].every(Number.isSafeInteger)) return null;
  return evidence;
}

function validateCounts(counts, total) {
  if (!isPlainObject(counts) || !Number.isSafeInteger(total) || total < 0) return false;
  const values = Object.values(counts);
  return values.length > 0
    && values.every((value) => Number.isSafeInteger(value) && value >= 0)
    && values.reduce((sum, value) => sum + value, 0) === total;
}

function deriveOutcome(result, snapshot, before, after) {
  if (!isPlainObject(result) || result.ok !== true || !isPlainObject(result.ingestMeta)) return OUTCOMES.UNKNOWN;
  if (result.ingestMeta.sourceType !== snapshot.sourceType
      || result.ingestMeta.sourceRef !== snapshot.sourceRef
      || result.ingestMeta.idempotencyKey !== snapshot.idempotencyKey) return OUTCOMES.UNKNOWN;
  const admission = result.admission;
  if (!isPlainObject(admission) || !['allow', 'review', 'reject'].includes(admission.outcome)
      || typeof admission.graphWrite !== 'boolean' || !validateCounts(admission.counts, admission.total)) {
    return OUTCOMES.UNKNOWN;
  }
  if (!Number.isSafeInteger(result.added) || result.added < 0) return OUTCOMES.UNKNOWN;
  const observedWrite = after.nodes !== before.nodes || after.edges !== before.edges;
  if (admission.graphWrite !== observedWrite || (result.added > 0) !== observedWrite) return OUTCOMES.UNKNOWN;
  if (admission.outcome === 'allow') return observedWrite ? OUTCOMES.ALLOW_WRITE : OUTCOMES.ALLOW_NO_WRITE;
  if (observedWrite) return OUTCOMES.UNKNOWN;
  return admission.outcome === 'review' ? OUTCOMES.REVIEW_NO_WRITE : OUTCOMES.REJECT_NO_WRITE;
}

function auditId() {
  return `ingest-approval-audit-${crypto.randomUUID()}`;
}

function appendApprovalAudit(graph, approval, receipt, auditRef, resultRef = '') {
  const snapshot = approval.context.snapshot;
  return graph.appendAuditEvent({
    auditId: auditRef,
    eventType: receipt.decision === 'approved' ? 'APPROVAL_APPROVED' : 'APPROVAL_REJECTED',
    targetType: 'ingest_approval',
    targetId: approval.id,
    details: {
      receipt,
      workspaceId: WORKSPACE_ID,
      snapshotHash: snapshot.snapshotHash,
      actionOwner: ACTION_OWNER,
      actionOwnerVersion: ACTION_OWNER_VERSION,
      actionOutcome: receipt.actionOutcome,
      resultRef,
    },
  }, { workspaceId: WORKSPACE_ID });
}

function finalizedResponse(approval) {
  const receipt = approval.context?.receipt || null;
  return response(200, {
    ok: true,
    idempotent: true,
    approval: publicIngestApproval(approval),
    receipt,
    auditRef: receipt?.metadata?.auditRefs?.[0] || '',
  });
}

async function decideIngestApproval({
  approvalId,
  decision,
  store,
  kernel,
  ensureRuntime,
  workerId,
  leaseMs,
  execute = handleIngest,
}) {
  if (!store || !kernel?.graph) return errorResponse(503, 'APPROVAL_STORE_UNAVAILABLE', 'Persistent ingest approval store is unavailable.');
  store.recoverExpiredToolApprovals({ tool: 'http.ingest', reason: 'execution_outcome_unknown:lease_expired' });
  const approval = store.getToolApprovalById(approvalId);
  if (!approval || approval.tool !== 'http.ingest') return errorResponse(404, 'APPROVAL_NOT_FOUND', 'Ingest approval was not found.');
  if (approval.status === 'approved' || approval.status === 'rejected') return finalizedResponse(approval);
  if (approval.status === 'failed') return errorResponse(409, 'APPROVAL_OUTCOME_UNKNOWN', 'Approval requires manual reconciliation.');
  if (approval.status !== 'pending') return errorResponse(409, 'APPROVAL_EXECUTION_IN_PROGRESS', 'Approval is already claimed or not pending.');

  const validated = validateSnapshot(approval);
  if (!validated.ok) return errorResponse(409, validated.code, 'Queued ingest snapshot does not satisfy the canonical authority contract.');
  const snapshot = validated.snapshot;

  if (decision === 'rejected') {
    const ref = auditId();
    const receipt = buildBlockedActionReceipt({
      approvalId, workspaceId: WORKSPACE_ID, actor: 'http-api', actionType: 'ingest', toolName: 'http.ingest',
      requestedVerdict: 'review', reason: 'http_ingest_rejected', createdAt: new Date().toISOString(),
    }, { metadata: {
      snapshotHash: snapshot.snapshotHash,
      reviewer: 'http-api',
      actionOwner: ACTION_OWNER,
      actionOwnerVersion: ACTION_OWNER_VERSION,
      auditRefs: [ref],
    } });
    const finalized = store.finalizeToolApprovalWithReceipt(approvalId, {
      expectedStatus: 'pending', decision: 'rejected', reason: 'http_ingest_rejected', receipt,
    });
    if (!finalized.finalized) return errorResponse(409, 'APPROVAL_DECISION_CONFLICT', 'Approval is no longer pending.');
    appendApprovalAudit(kernel.graph, finalized.approval, receipt, ref);
    return response(200, { ok: true, approval: publicIngestApproval(finalized.approval), receipt, auditRef: ref });
  }

  const claim = store.claimToolApprovalWithLease(approvalId, {
    owner: workerId,
    leaseMs,
    reason: 'http_ingest_execution_claimed',
  });
  if (!claim.claimed) return errorResponse(409, 'APPROVAL_EXECUTION_IN_PROGRESS', 'Approval is already claimed or not pending.');
  const executing = claim.approval;
  const claimedSnapshot = validateSnapshot(executing);
  if (!claimedSnapshot.ok) {
    store.failToolApproval(approvalId, `execution_outcome_unknown:${claimedSnapshot.code}`);
    return errorResponse(409, claimedSnapshot.code, 'Claimed ingest snapshot no longer validates.');
  }

  const before = graphEvidence(kernel.graph);
  if (!before) {
    store.failToolApproval(approvalId, 'execution_outcome_unknown:graph_evidence_unavailable');
    return errorResponse(409, 'GRAPH_EVIDENCE_UNAVAILABLE', 'Bounded Graph evidence is unavailable.');
  }

  let leaseLost = false;
  const heartbeat = setInterval(() => {
    try {
      const renewed = store.renewToolApprovalLease(approvalId, workerId, leaseMs);
      if (!renewed.renewed) leaseLost = true;
    } catch (_) {
      leaseLost = true;
    }
  }, Math.max(5_000, Math.floor(leaseMs / 2)));
  heartbeat.unref?.();

  let result;
  try {
    result = await execute({ kernel, data: claimedSnapshot.snapshot.payload, ensureRuntime });
  } catch (_) {
    clearInterval(heartbeat);
    store.failToolApproval(approvalId, 'execution_outcome_unknown:dependency_exception');
    return errorResponse(409, 'INGEST_EXECUTION_UNKNOWN', 'Approved ingest outcome is unknown; manual reconciliation is required.');
  }
  clearInterval(heartbeat);
  if (leaseLost) {
    store.failToolApproval(approvalId, 'execution_outcome_unknown:lease_lost');
    return errorResponse(409, 'APPROVAL_LEASE_LOST', 'Approval lease was lost; manual reconciliation is required.');
  }

  const after = graphEvidence(kernel.graph);
  const outcome = after ? deriveOutcome(result, claimedSnapshot.snapshot, before, after) : OUTCOMES.UNKNOWN;
  if (outcome === OUTCOMES.UNKNOWN) {
    store.failToolApproval(approvalId, 'execution_outcome_unknown:evidence_conflict');
    return errorResponse(409, 'INGEST_EXECUTION_UNKNOWN', 'Approved ingest evidence is incomplete or contradictory.');
  }

  const ref = auditId();
  const resultRef = sha256(result);
  const receipt = buildReviewedActionReceipt({
    approvalId, workspaceId: WORKSPACE_ID, actor: 'http-api', actionType: 'ingest', toolName: 'http.ingest',
    requestedVerdict: 'review', reason: 'http_ingest_executed', createdAt: new Date().toISOString(),
  }, { metadata: {
    snapshotHash: claimedSnapshot.snapshot.snapshotHash,
    sourceType: claimedSnapshot.snapshot.sourceType,
    sourceRef: claimedSnapshot.snapshot.sourceRef,
    idempotencyKey: claimedSnapshot.snapshot.idempotencyKey,
    reviewer: 'http-api',
    actionOwner: ACTION_OWNER,
    actionOwnerVersion: ACTION_OWNER_VERSION,
    resultRef,
    graphBeforeRef: sha256(before),
    graphAfterRef: sha256(after),
    admissionOutcome: result.admission.outcome,
    auditRefs: [ref],
  } });
  receipt.actionExecution = 'bounded_ingest_action_returned';
  receipt.actionOutcome = outcome;
  const finalized = store.finalizeToolApprovalWithReceipt(approvalId, {
    expectedStatus: 'executing', decision: 'approved', reason: 'http_ingest_executed', receipt,
  });
  if (!finalized.finalized) return errorResponse(409, 'APPROVAL_FINALIZATION_CONFLICT', 'Approval finalization requires manual reconciliation.');
  appendApprovalAudit(kernel.graph, finalized.approval, receipt, ref, resultRef);
  return response(200, {
    ok: true,
    approval: publicIngestApproval(finalized.approval),
    result,
    receipt,
    auditRef: ref,
  });
}

module.exports = {
  ACTION_OWNER,
  ACTION_OWNER_VERSION,
  OUTCOMES,
  WORKSPACE_ID,
  decideIngestApproval,
  publicIngestApproval,
  _test: { deriveOutcome, graphEvidence, validateSnapshot },
};
