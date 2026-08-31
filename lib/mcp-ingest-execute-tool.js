'use strict';

const crypto = require('crypto');
const { buildIngestApprovalSnapshot, handleIngest, sha256 } = require('./ingest');
const { decideIngestApproval } = require('./workbench/ingest-approval-action');
const { createIngestApprovalAuditWriter } = require('./workbench/ingest-approval-audit-writer');
const { absent, createMutationAdmission } = require('./mutation-admission');
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

/**
 * The audit writer this surface hands to the approval owner.
 *
 * There used to be a second writer here, spelled out inline, and it was not a
 * different kind of write: `docs/task-packs/p1d-audit-family-independence.md`
 * measured that it produced the same event as the one `server.js` injects --
 * same eventType derivation, same targetType, same details keys, same
 * `sha256`. HTTP and MCP drive the *same* approval owner,
 * `decideIngestApproval`, which takes the audit write as an injected
 * `recordAudit` port; the only thing that differed between the two transports
 * was which writer went into that port.
 *
 * So this was never a boundary that did not exist. It was one transport not
 * using the boundary the other one already had, and the routed writer's
 * admission check was reachable through HTTP and unreachable through MCP for
 * no reason anybody had decided.
 *
 * Constructing the same writer here rather than inventing an MCP-shaped one is
 * the whole change: a duplicate is deleted, not a seam added. Nothing about
 * admission semantics is decided here -- verdict 2 of that measurement
 * (what a refused audit write should mean for the holders that swallow
 * failures) stays open, and this path is unaffected by it because it already
 * had a defined meaning for a throw. See the refusal note on
 * `decideMcpIngestApproval`.
 */
function defaultIngestApprovalAuditWriter(kernel, ledger = null) {
  return createIngestApprovalAuditWriter({
    graph: kernel.graph,
    admission: createMutationAdmission({
      identityEvaluator: absent(
        'MCP ingest execute carries no receiver-owned identity claim; the MCP '
        + 'surface gates on its own approval flow, not on an identity decision',
      ),
    }),
    hashResult: sha256,
    ledger,
  });
}

function buildMcpIngestExecuteResult(kernel, args, gate) {
  const request = buildMcpIngestApproval(args, gate);
  return request.ok
    ? kernel._fail('ingest_execute', 'APPROVAL_REQUIRED', 'Ingest execution must remain behind the approval owner.')
    : kernel._fail('ingest_execute', request.code, request.error);
}

function approvalFailure(fail, response, approvalStore, approvalId, workspaceId = 'default') {
  const current = formatApprovalRecord(response?.approval || approvalStore.getToolApprovalById(approvalId, workspaceId));
  const error = response?.error || { code: 'APPROVAL_EXECUTION_FAILED', message: 'MCP ingest approval failed.' };
  return fail(error.code, error.message, { approval: current, retrySafe: false });
}

/**
 * What a refused audit write does on this path.
 *
 * The routed writer throws when admission refuses, and the previous inline
 * writer did not have that behaviour, so the question has to be answered
 * rather than assumed. It is answered by machinery that already exists and is
 * not modified here: `recordAuditEvidence` catches any throw from the
 * `recordAudit` port and turns it into `audit_append_failed`, which
 * `auditOrGap` turns into the `AUDIT_EVIDENCE_MISSING` reconciliation
 * response -- "the durable part happened, the evidence did not", `retry:
 * false`. That response arrives here with `status: 409` and is handed to
 * `approvalFailure`.
 *
 * So the refusal lands on the *same* bounded state a failed audit write
 * already landed on, and this unit invents no vocabulary for it.
 *
 * ## A pre-existing discrepancy, deliberately left alone
 *
 * What this surface reports for that state is *not* `AUDIT_EVIDENCE_MISSING`.
 * `auditEvidenceGap` returns `{ status, json: { error } }` while `apiError`
 * returns `{ status, error }`, and `approvalFailure` reads `response.error` --
 * which is absent on the gap shape, so it falls back to
 * `APPROVAL_EXECUTION_FAILED`. `retrySafe: false` is preserved, so the
 * no-retry rule that actually protects against a duplicate write holds; the
 * reconciliation identifiers do not reach the MCP caller. Over HTTP they do:
 * `server.js` writes `outcome.json` as the 409 body.
 *
 * This behaviour is **identical before and after this change** -- measured
 * against `origin/main`, where a throwing writer produced the same
 * `APPROVAL_EXECUTION_FAILED` -- so it is not a regression introduced here,
 * and fixing it is not in scope for a duplicate deletion. It is recorded
 * because it belongs with verdict 2 of
 * `docs/task-packs/p1d-audit-family-independence.md`: what an audit-evidence
 * gap should mean to a caller is a product decision, and this surface quietly
 * answers it differently from the HTTP one.
 */
async function decideMcpIngestApproval({ kernel, approvalStore, approvalId, workspaceId = 'default', decision, reason, runtime = {}, fail }) {
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
      workspaceId,
      decision,
      handleIngest: runtime.handleIngest || handleIngest,
      ensureRuntime: runtime.ensureRuntime || (() => {}),
      recordAudit: runtime.recordIngestApprovalAudit || defaultIngestApprovalAuditWriter(kernel, runtime.trustEvidenceLedger || null),
      toPublicApproval: formatApprovalRecord,
      workerId: runtime.workerId || DEFAULT_WORKER_ID,
      leaseMs: runtime.leaseMs || DEFAULT_LEASE_MS,
    });
  } catch (error) {
    return fail('APPROVAL_EXECUTION_FAILED', 'MCP ingest approval failed; outcome requires manual reconciliation.', {
      approval: formatApprovalRecord(approvalStore.getToolApprovalById(approvalId, workspaceId)),
      retrySafe: false,
      failure: error?.code || error?.name || 'error',
    });
  }

  if (!response || response.status >= 400 || response.error) {
    return approvalFailure(fail, response, approvalStore, approvalId, workspaceId);
  }

  const json = response.json || {};
  return {
    ok: true,
    type: 'approval',
    data: {
      approval: json.approval || formatApprovalRecord(approvalStore.getToolApprovalById(approvalId, workspaceId)),
      decision,
      executed: decision === 'approved' && Boolean(json.result),
      idempotent: json.idempotent === true,
      result: json.result || null,
      receipt: json.receipt || null,
      refs: json.auditRef ? { auditRef: json.auditRef, ...(json.trustReceiptId ? { trustReceiptId: json.trustReceiptId } : {}) } : null,
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
