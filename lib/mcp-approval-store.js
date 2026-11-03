'use strict';

const { createKernel } = require('./kernel-factory');
const { canonicalMcpToolName } = require('./mcp-tool-names');
const { bindReviewedCall } = require('./mcp-call-binding');
const { formatApprovalRecord } = require('./mcp-approval-views');
const { createDefaultApprovalStorage } = require('./mcp-approval-store-factory');
const { finalizeApprovalExecution } = require('./approval-execution-evidence');
const { sanitizeToolArgsForStorage, nowMs, newApprovalId } = require('./mcp-input-sanitizers');
const { buildCandidateClaim } = require('./conflict-detector');
const { saveMcpIngestApproval } = require('./mcp-ingest-execute-tool');
const { resolveMcpApprovalTtlMs, mcpApprovalExpiresAt } = require('./mcp-approval-expiry');

function createKernelFromEnv() {
  return createKernel({ loadPlugins: false });
}

/**
 * Resolve the approval store for a kernel. Prefers an injected store
 * (`opts.approvalStore`) or factory (`opts.createStorage`); only when the
 * caller supplied neither does it fall back to the default factory (#2351).
 */
function createApprovalStoreFromKernel(kernel, opts = {}) {
  if (opts.approvalStore !== undefined) return opts.approvalStore;
  const createStorage = typeof opts.createStorage === 'function'
    ? opts.createStorage
    : createDefaultApprovalStorage;
  try {
    const storageOpts = { kernel };
    if (opts.dbPath) storageOpts.dbPath = opts.dbPath;
    if (opts.memoryPath) storageOpts.memoryPath = opts.memoryPath;
    return createStorage(storageOpts);
  } catch (_) {
    return null;
  }
}

const APPROVAL_STORE_METHODS = Object.freeze([
  'getToolApprovalById',
  'claimToolApproval',
  'rejectToolApproval',
  'failToolApproval',
  'finalizeToolApprovalWithReceipt',
]);

/**
 * Resolve the store the decision path acts on, or null when it cannot act.
 * Moved from lib/mcp-approval-decision-handler.js (#2207): choosing the
 * store is a store concern; deciding on the approval stays with the handler.
 */
function requireApprovalStore(runtime = {}, kernel) {
  const approvalStore = runtime.approvalStore || createApprovalStoreFromKernel(kernel, runtime);
  if (!approvalStore || !APPROVAL_STORE_METHODS.every((method) => typeof approvalStore[method] === 'function')) {
    return null;
  }
  return approvalStore;
}

/**
 * Reconcile stuck leaseless claims against the durable mutation journal (#4482).
 *
 * The H-07 sweep (`recoverStuckLeaselessToolApprovals`) fails every stuck row,
 * because the approval row is the only record it consults. When the approved
 * mutation committed before the crash, that turns a completed write into
 * `execution_outcome_unknown` and never attaches its canonical receipt. The
 * journal is the authority that can tell the two apart, and the decision
 * handler reaches it through the kernel graph.
 *
 * Per stuck row: a committed mutation is finalized from its stored result
 * (idempotent, never re-executed); anything else stays fail-closed and is
 * failed exactly as the H-07 sweep would.
 */
function reconcileStuckLeaselessClaims(approvalStore, graph) {
  const reconciled = { finalized: [], failed: [] };
  if (!graph || typeof graph.getCommittedMutationResultByOperation !== 'function') return reconciled;
  if (typeof approvalStore.listStuckLeaselessExecutingToolApprovals !== 'function') return reconciled;
  let stuck;
  try {
    stuck = approvalStore.listStuckLeaselessExecutingToolApprovals({});
  } catch (_) {
    // The read failed; leave the row alone so the H-07 sweep stays the
    // fail-closed fallback rather than guessing at the outcome.
    return reconciled;
  }
  for (const approval of stuck) {
    // Hydrated rows keep the raw column names (`workspace_id`); the CAS
    // statements match on it, so passing the wrong workspace would make the
    // write silently match nothing.
    const workspaceId = approval.workspace_id || 'default';
    let committed = null;
    try {
      committed = graph.getCommittedMutationResultByOperation(approval.id);
    } catch (_) {
      committed = null;
    }
    if (committed && committed.result && typeof committed.result === 'object') {
      const finalization = finalizeApprovalExecution({
        store: approvalStore,
        approvalId: approval.id,
        workspaceId,
        reason: 'approval_execution_reconciled_from_journal',
        graph,
        result: committed.result,
      });
      if (finalization.approval && finalization.approval.status === 'approved') {
        reconciled.finalized.push(approval.id);
        continue;
      }
      // Committed, but its canonical receipt could not be materialized, so the
      // row cannot be finalized as approved. Failing it terminal is the only
      // outcome that does not leave the row `executing` forever; the reason
      // mirrors the live path's (mcp-approval-learn-execution.js).
      const unmaterialized = approvalStore.failToolApproval(
        approval.id,
        'execution_outcome_unknown:receipt_not_materialized',
        workspaceId,
      );
      if (unmaterialized?.failed) reconciled.failed.push(approval.id);
      continue;
    }
    const failure = approvalStore.failToolApproval(
      approval.id,
      'execution_outcome_unknown:stuck_leaseless_execution',
      workspaceId,
    );
    if (failure?.failed) reconciled.failed.push(approval.id);
  }
  return reconciled;
}

/**
 * Reap stuck leaseless claim rows best-effort. H-07 (#1980): the MCP
 * agent/learn claim is leaseless, so a crash between claim and finalize
 * leaves the row `executing` with no lease for the lease sweeper to expire.
 *
 * With the kernel graph available the journal is consulted first (#4482), so a
 * mutation that committed before the crash is finalized from its stored result
 * instead of being reported as an unknown outcome. Without it -- or without
 * the read-only lister -- the H-07 sweep remains the fail-closed fallback.
 * Recovery only fails or finalizes rows, never re-executes them; the claim
 * below stays authoritative.
 */
function reapStuckLeaselessClaims(approvalStore, graph) {
  try {
    if (graph && typeof graph.getCommittedMutationResultByOperation === 'function'
        && typeof approvalStore.listStuckLeaselessExecutingToolApprovals === 'function') {
      reconcileStuckLeaselessClaims(approvalStore, graph);
      return approvalStore;
    }
    if (typeof approvalStore.recoverStuckLeaselessToolApprovals === 'function') {
      approvalStore.recoverStuckLeaselessToolApprovals({});
    }
  } catch (_) { /* best-effort; the claim below stays authoritative */ }
  return approvalStore;
}

function saveMcpApproval(approvalStore, name, args, gate, options = {}) {
  if (canonicalMcpToolName(name) === 'huqan.ingest_execute') {
    return saveMcpIngestApproval(approvalStore, args, gate);
  }

  const createdAt = nowMs();
  const id = newApprovalId();
  const approvalKey = `mcp.${name}.${id}`;
  // A pending approval is not approvable forever (#3486). The instant is
  // stamped on the row here, at decision-time re-check it is enforced, and a
  // row written before this change (no expiresAt) is measured from
  // createdAt + the same TTL so it cannot stay approvable indefinitely.
  const approvalExpiresAt = mcpApprovalExpiresAt(createdAt, resolveMcpApprovalTtlMs(options.readEnvironment));
  const cleanArgs = sanitizeToolArgsForStorage(name, args);
  const queuedForExecution = canonicalMcpToolName(name) === 'huqan.learn';
  const pendingCandidate = queuedForExecution
    ? buildCandidateClaim({
        candidateId: `cand_${id}`,
        claim: cleanArgs.text,
        workspaceId: cleanArgs.workspaceId || gate.metadata?.workspaceId || 'default',
        provenance: cleanArgs.provenance,
        sourceRef: cleanArgs.provenance?.sourceRef || approvalKey,
        sourceTitle: cleanArgs.provenance?.sourceTitle || 'MCP learn review candidate',
        sourceType: cleanArgs.provenance?.sourceType || 'api',
        sourceSubType: cleanArgs.provenance?.sourceSubType || 'mcp.learn',
        actor: cleanArgs.provenance?.actor || 'mcp.learn',
        confidence: cleanArgs.provenance?.confidence,
      })
    : null;
  const approval = {
    id,
    approvalKey,
    tool: name,
    input: JSON.stringify(cleanArgs),
    status: 'pending',
    decision: 'review',
    reason: gate.reason,
    createdAt,
    updatedAt: createdAt,
    policy: {
      gate: {
        decision: gate.decision,
        allowed: gate.allowed,
        canExecute: gate.canExecute,
        canDryRun: gate.canDryRun,
        requiredReview: gate.requiredReview,
        reason: gate.reason,
        riskScore: Number.isFinite(Number(gate.risk?.score))
          ? Math.max(0, Math.min(100, Number(gate.risk.score)))
          : 0,
        metadata: gate.metadata || {},
      },
      // The arguments the reviewer is shown; `input` is their JSON (#3488).
      reviewedBinding: bindReviewedCall(canonicalMcpToolName(name), cleanArgs, { inputIsArgs: true }),
    },
    context: {
      source: 'mcp',
      workspaceId: cleanArgs.workspaceId || gate.metadata?.workspaceId || 'default',
      queuedForExecution,
      args: cleanArgs,
      ...(approvalExpiresAt ? { expiresAt: approvalExpiresAt } : {}),
      ...(pendingCandidate
        ? {
            reviewRequired: true,
            candidateId: pendingCandidate.candidate.candidateId,
            memoryDraftId: pendingCandidate.candidate.candidateId,
            workspaceId: pendingCandidate.candidate.workspaceId,
            candidate: pendingCandidate.candidate,
            provenance: pendingCandidate.provenance,
          }
        : {}),
      ...(options.oversightRequired === true ? { oversightRequired: true } : {}),
    },
  };

  // Every return says whether a durable row exists, because the caller uses
  // that to decide whether it may claim the call was queued for review (#772).
  // A missing store and a failing store are the same fact to a caller: no
  // approval was recorded, so nothing is waiting for a human.
  if (!approvalStore || typeof approvalStore.saveToolApproval !== 'function') {
    return { ...approval, persisted: false, notPersistedReason: 'approval_store_unavailable' };
  }

  let saved;
  try {
    saved = approvalStore.saveToolApproval(approval);
  } catch (error) {
    // The raw error is a filesystem/SQLite detail and never leaves this
    // function; the caller gets a bounded reason.
    console.error('[mcp-approval-store] save failed:', error);
    return { ...approval, persisted: false, notPersistedReason: 'approval_store_write_failed' };
  }

  const record = formatApprovalRecord(saved);
  if (record) return { ...record, persisted: true };
  // A store that accepted the write but returned nothing recognizable has not
  // shown us a row, so it does not get to be reported as one.
  return { ...approval, persisted: false, notPersistedReason: 'approval_store_write_unconfirmed' };
}

module.exports = {
  createKernelFromEnv,
  createApprovalStoreFromKernel,
  reapStuckLeaselessClaims,
  reconcileStuckLeaselessClaims,
  requireApprovalStore,
  saveMcpApproval,
};
