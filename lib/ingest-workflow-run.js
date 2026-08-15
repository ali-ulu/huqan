'use strict';

const { SOURCE_MANIFEST_VERSION } = require('./ingest-workflow-preview');

const STATUS_PROJECTION = Object.freeze({
  pending: Object.freeze({ status: 'review_required', completed: 0, phase: 'awaiting_review' }),
  executing: Object.freeze({ status: 'queued', completed: 0, phase: 'executing' }),
  approved: Object.freeze({ status: 'completed', completed: 1, phase: 'finalized' }),
  rejected: Object.freeze({ status: 'blocked', completed: 0, phase: 'rejected' }),
  failed: Object.freeze({ status: 'failed', completed: 0, phase: 'reconciliation_required' }),
});

function buildIngestWorkflowRun(approval) {
  const snapshot = approval?.context?.snapshot;
  const projection = STATUS_PROJECTION[approval?.status];
  if (!snapshot || !projection) return null;

  const receiptId = String(approval.context?.receipt?.receiptId || '');
  const nextAction = approval.status === 'pending'
    ? 'review'
    : approval.status === 'executing' ? 'poll' : receiptId ? 'read_receipt' : null;
  return {
    workflowId: 'ingest-run-detail',
    runId: String(approval.id || ''),
    status: projection.status,
    phase: projection.phase,
    sourceManifest: {
      version: SOURCE_MANIFEST_VERSION,
      workspaceId: snapshot.workspaceId,
      sourceType: snapshot.sourceType,
      sourceRef: snapshot.sourceRef,
      sourceDigest: snapshot.snapshotHash,
      idempotencyKey: snapshot.idempotencyKey,
      itemCount: 1,
    },
    progress: { completed: projection.completed, total: 1, hasMore: false },
    retry: {
      allowed: false,
      reason: approval.status === 'failed'
        ? 'outcome_unknown_requires_manual_reconciliation'
        : 'idempotent_submission_reuses_the_existing_run',
    },
    resume: {
      allowed: false,
      reason: 'ingest_runs_have_no_paused_checkpoint',
    },
    nextAction,
    approvalId: String(approval.id || ''),
    receiptId: receiptId || null,
  };
}

module.exports = { buildIngestWorkflowRun };
