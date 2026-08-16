'use strict';

const crypto = require('crypto');
const { buildIngestApprovalSnapshot, handleIngest, sha256 } = require('./ingest');
const { decideIngestApproval } = require('./workbench/ingest-approval-action');
const { formatApprovalRecord } = require('./mcp-approval-views');
const { sanitizeToolArgsForStorage, nowMs, newApprovalId } = require('./mcp-input-sanitizers');

const MCP_TOOL_NAME = 'huqan.ingest_execute';
const APPROVAL_TOOL_NAME = 'http.ingest';
const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_WORKER_ID = `mcp-ingest-${typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Date.now()}`;

function buildMcpIngestApproval(args = {}, gate = {}) {
  const snapshot = buildIngestApprovalSnapshot(args);
  if (!snapshot.ok) {
    return {
      ok: false,
      code: snapshot.code || 'INGEST_SNAPSHOT_REQUIRED',
      error: snapshot.error || 'Ingest cannot be queued safely.',
    };
  }

  const cleanArgs = sanitizeToolArgsForStorage(MCP_TOOL_NAME, args);
  const approvalKey = `${APPROVAL_TOOL_NAME}.${snapshot.sourceType}.${snapshot.idempotencyKey}.${snapshot.snapshotHash}`;
  const createdAt = nowMs();
  return {
    ok: true,
    approval: {
      id: newApprovalId(),
      approvalKey,
      tool: APPROVAL_TOOL_NAME,
      input: JSON.stringify(snapshot.payload),
      status: 'pending',
      decision: 'review',
      reason: gate.reason || 'mcp_ingest_requires_review',
      createdAt,
      updatedAt: createdAt,
      policy: {
        action: 'ingest',
        approval: 'review',
        snapshotIntegrity: 'sha256',
        source: 'mcp',
      },
      context: {
        source: 'mcp-ingest',
        mcpTool: MCP_TOOL_NAME,
        queuedForExecution: true,
        args: cleanArgs,
        snapshot,
      },
    },
  };
}

function saveMcpIngestApproval(approvalStore, args = {}, gate = {}) {
  const built = buildMcpIngestApproval(args, gate);
  if (!built.ok) {
    return {
      id: '',
      approvalKey: '',
      tool: APPROVAL_TOOL_NAME,
      status: 'blocked',
      decision: 'blocked',
      reason: built.code,
      context: { source: 'mcp-ingest' },
      persisted: false,
      notPersistedReason: built.code,
      error: { code: built.code, message: built.error },
    };
  }

  if (!approvalStore || (typeof approvalStore.saveToolApproval !== 'function'
      && typeof approvalStore.saveToolApprovalIfAbsent !== 'function')) {
    return { ...built.approval, persisted: false, notPersistedReason: 'approval_store_unavailable' };
  }

  try {
    const saved = typeof approvalStore.saveToolApprovalIfAbsent === 'function'
      ? approvalStore.saveToolApprovalIfAbsent(built.approval)
      : approvalStore.saveToolApproval(built.approval);
    const record = formatApprovalRecord(saved?.approval || saved);
    if (record) return { ...record, persisted: true, idempotent: saved?.inserted === false };
  } catch (error) {
    console.error('[mcp-ingest-approval-store] save failed:', error);
    return { ...built.approval, persisted: false, notPersistedReason: 'approval_store_write_failed' };
  }

  return { ...built.approval, persisted: false, notPersistedReason: 'approval_store_write_unconfirmed' };
}

function recordMcpIngestApprovalAudit(kernel, approval, receipt, result = null) {
  const snapshot = approval.context?.snapshot || {};
  return kernel.graph.appendAuditEvent({
    eventType: receipt.decision === 'approved' ? 'APPROVAL_APPROVED' : 'APPROVAL_REJECTED',
    targetType: 'ingest_approval',
    targetId: approval.id,
    details: {
      receipt,
      snapshotHash: snapshot.snapshotHash || '',
      pluginResultRef: result ? sha256(result) : '',
      actionOutcome: receipt.actionOutcome || '',
      executionGuarantee: 'bounded_action_outcome',
    },
  }, { workspaceId: snapshot.workspaceId });
}

function buildMcpIngestExecuteResult(kernel, args, gate) {
  const request = buildMcpIngestApproval(args, gate);
  return request.ok
    ? kernel._fail('ingest_execute', 'APPROVAL_REQUIRED', 'Ingest execution must remain behind the approval owner.')
    : kernel._fail('ingest_execute', request.code, request.error);
}

function approvalFailure(fail, response, approvalStore, approvalId) {
  const current = formatApprovalRecord(response?.approval || approvalStore.getToolApprovalById(approvalId));
  const error = response?.error || { code: 'APPROVAL_EXECUTION_FAILED', message: 'MCP ingest approval failed.' };
  return fail(error.code, error.message, { approval: current, retrySafe: false });
}

async function decideMcpIngestApproval({ kernel, approvalStore, approvalId, decision, reason, runtime = {}, fail }) {
  if (!approvalStore || typeof approvalStore.claimToolApprovalWithLease !== 'function'
      || typeof approvalStore.renewToolApprovalLease !== 'function') {
    return fail('APPROVAL_STORE_UNAVAILABLE', 'Persistent ingest approval store cannot execute leases.');
  }

  let response;
  try {
    response = await decideIngestApproval({
      store: approvalStore,
      kernel,
      approvalId,
      decision,
      handleIngest: runtime.handleIngest || handleIngest,
      ensureRuntime: runtime.ensureRuntime || (() => {}),
      recordAudit: runtime.recordIngestApprovalAudit || ((approval, receipt, result) => recordMcpIngestApprovalAudit(kernel, approval, receipt, result)),
      toPublicApproval: formatApprovalRecord,
      workerId: runtime.workerId || DEFAULT_WORKER_ID,
      leaseMs: runtime.leaseMs || DEFAULT_LEASE_MS,
    });
  } catch (error) {
    return fail('APPROVAL_EXECUTION_FAILED', 'MCP ingest approval failed; outcome requires manual reconciliation.', {
      approval: formatApprovalRecord(approvalStore.getToolApprovalById(approvalId)),
      retrySafe: false,
      failure: error?.code || error?.name || 'error',
    });
  }

  if (!response || response.status >= 400 || response.error) {
    return approvalFailure(fail, response, approvalStore, approvalId);
  }

  const json = response.json || {};
  return {
    ok: true,
    type: 'approval',
    data: {
      approval: json.approval || formatApprovalRecord(approvalStore.getToolApprovalById(approvalId)),
      decision,
      executed: decision === 'approved' && Boolean(json.result),
      idempotent: json.idempotent === true,
      result: json.result || null,
      receipt: json.receipt || null,
      refs: json.auditRef ? { auditRef: json.auditRef } : null,
    },
    evidence: Array.isArray(json.result?.evidence) ? json.result.evidence : [],
    error: null,
    meta: { ingestApprovalOwner: 'lib/workbench/ingest-approval-action' },
  };
}

module.exports = {
  MCP_TOOL_NAME,
  APPROVAL_TOOL_NAME,
  buildMcpIngestApproval,
  saveMcpIngestApproval,
  buildMcpIngestExecuteResult,
  decideMcpIngestApproval,
};
