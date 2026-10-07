'use strict';

const { createKernel } = require('./kernel-factory');
const { canonicalMcpToolName } = require('./mcp-tool-names');
const { bindReviewedCall } = require('./mcp-call-binding');
const { formatApprovalRecord } = require('./mcp-approval-views');
const { createDefaultApprovalStorage } = require('./mcp-approval-store-factory');
const { sanitizeToolArgsForStorage, nowMs, newApprovalId } = require('./mcp-input-sanitizers');
const { buildCandidateClaim } = require('./conflict-detector');
const { saveMcpIngestApproval } = require('./mcp-ingest-execute-tool');

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
 * Reap stuck leaseless claim rows best-effort. H-07 (#1980): the MCP
 * agent/learn claim is leaseless, so a crash between claim and finalize
 * leaves the row `executing` with no lease for the lease sweeper to expire.
 * Moved from lib/mcp-approval-decision-handler.js (#2207). Recovery only
 * fails rows, never re-executes them; the claim below stays authoritative.
 */
function reapStuckLeaselessClaims(approvalStore) {
  try {
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
  requireApprovalStore,
  saveMcpApproval,
};
