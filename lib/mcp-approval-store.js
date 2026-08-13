'use strict';

const { createKernel } = require('./kernel-factory');
const { canonicalMcpToolName } = require('./mcp-tool-names');
const { formatApprovalRecord } = require('./mcp-approval-views');
const AxiomStorage = require('../storage');
const { sanitizeToolArgsForStorage, nowMs, newApprovalId } = require('./mcp-input-sanitizers');

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
    return new AxiomStorage(storageOpts);
  } catch (_) {
    return null;
  }
}

function saveMcpApproval(approvalStore, name, args, gate) {
  const createdAt = nowMs();
  const id = newApprovalId();
  const approvalKey = `mcp.${name}.${id}`;
  const cleanArgs = sanitizeToolArgsForStorage(name, args);
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
      queuedForExecution: canonicalMcpToolName(name) === 'huqan.learn',
      args: cleanArgs,
    },
  };

  if (!approvalStore || typeof approvalStore.saveToolApproval !== 'function') {
    return { ...approval, persisted: false };
  }

  const saved = approvalStore.saveToolApproval(approval);
  return formatApprovalRecord(saved) || { ...approval, persisted: true };
}

module.exports = {
  createKernelFromEnv,
  createApprovalStoreFromKernel,
  saveMcpApproval,
};
