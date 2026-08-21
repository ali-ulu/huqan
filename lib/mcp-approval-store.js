'use strict';

const { createKernel } = require('./kernel-factory');
const { canonicalMcpToolName } = require('./mcp-tool-names');
const { formatApprovalRecord } = require('./mcp-approval-views');
const HuqanStorage = require('../storage');
const { sanitizeToolArgsForStorage, nowMs, newApprovalId } = require('./mcp-input-sanitizers');
const { buildCandidateClaim } = require('./conflict-detector');
const { saveMcpIngestApproval } = require('./mcp-ingest-execute-tool');

function createKernelFromEnv() {
  return createKernel({ loadPlugins: false });
}

function createApprovalStoreFromKernel(kernel, opts = {}) {
  if (opts.approvalStore !== undefined) return opts.approvalStore;
  if (!opts.dbPath && !opts.memoryPath && !kernel?.graph?.memoryPath) return null;
  try {
    const storageOpts = { kernel };
    if (opts.dbPath) storageOpts.dbPath = opts.dbPath;
    if (opts.memoryPath) storageOpts.memoryPath = opts.memoryPath;
    return new HuqanStorage(storageOpts);
  } catch (_) {
    return null;
  }
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
        metadata: gate.metadata || {},
      },
    },
    context: {
      source: 'mcp',
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
  saveMcpApproval,
};
