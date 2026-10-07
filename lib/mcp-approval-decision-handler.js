'use strict';

const {
  MCP_MAX_TEXT,
  MCP_MAX_SHORT,
  sanitizeMcpString,
  sanitizeMcpApprovalDecision,
  sanitizeToolArgsForStorage,
} = require('./mcp-input-sanitizers');
const { requireApprovalStore, reapStuckLeaselessClaims } = require('./mcp-approval-store');
const {
  createMcpOversightCase,
  decideMcpOversight,
  evaluateMcpAgentIdentity,
  getHumanOversightRuntime,
  oversightSummary,
  readMcpOversightCase,
} = require('./mcp-human-oversight-adapter');
const { executeApprovedLearn } = require('./mcp-approval-learn-execution');
const { canonicalMcpToolName } = require('./mcp-tool-names');
const { parseJsonObject } = require('./json-object');
const { reviewedArgsHold } = require('./mcp-call-binding');
const { formatApprovalRecord } = require('./mcp-approval-views');
const { isMcpApprovalExpired, resolveMcpApprovalTtlMs } = require('./mcp-approval-expiry');
const { buildBlockedActionReceipt } = require('./approval-receipts');
const { decideMcpIngestApproval } = require('./mcp-ingest-execute-tool');
const { idempotentApprovalDecision } = require('./approval-execution-evidence');
const { executeApprovedMcpAgent } = require('./mcp-agent-approval-execution');
const { executeApprovedRepair } = require('./mcp-agent-repair-execution');

function handleMcpApprovalDecision(kernel, args = {}, runtime = {}, failApprovalDecision) {
  const approvalStore = requireApprovalStore(runtime, kernel);
  if (!approvalStore) {
    return failApprovalDecision('APPROVAL_STORE_UNAVAILABLE', 'Persistent MCP approval store is unavailable.');
  }
  reapStuckLeaselessClaims(approvalStore);

  const approvalId = sanitizeMcpString(args.approvalId, MCP_MAX_SHORT);
  if (!approvalId) {
    return failApprovalDecision('APPROVAL_ID_REQUIRED', 'approvalId is required.');
  }
  // Raw legacy callers may omit the field; defaulting to the canonical
  // workspace remains fail-closed because every durable read and mutation is
  // still qualified by this value. Published MCP schemas require the field.
  const workspaceId = sanitizeMcpString(args.workspaceId, MCP_MAX_SHORT) || 'default';

  // #615: only a genuinely absent decision field defaults to 'approved'.
  // A present-but-invalid value (wrong enum, empty string, whitespace) must
  // fail closed rather than silently falling into the most privileged
  // branch -- args.decision || 'approved' could not tell those cases apart.
  const decisionProvided = args.decision !== undefined && args.decision !== null;
  const decision = sanitizeMcpApprovalDecision(decisionProvided ? args.decision : 'approved');
  if (!decision) {
    return failApprovalDecision('INVALID_APPROVAL_DECISION', 'decision must be "approved" or "rejected".');
  }
  const reason = sanitizeMcpString(args.reason || `mcp_${decision}`, MCP_MAX_TEXT);
  const existing = formatApprovalRecord(approvalStore.getToolApprovalById(approvalId, workspaceId));
  if (!existing) {
    return failApprovalDecision('APPROVAL_NOT_FOUND', `Approval not found: ${approvalId}`);
  }

  if (existing.status === 'approved' || existing.status === 'rejected') {
    if (existing.status !== decision) {
      return failApprovalDecision('APPROVAL_ALREADY_FINAL', `Approval is already ${existing.status}.`, { approval: existing });
    }
    return idempotentApprovalDecision(existing, decision);
  }

  // A pending approval that outlived its lifetime is not approvable (#3486).
  // Checked here, at decision time, so a row queued under one risk assessment
  // cannot be executed later under another. Rows written before this change
  // carry no expiresAt and are measured from createdAt + the current TTL, so
  // an old pending row is expired rather than approvable forever.
  if (decision === 'approved'
      && isMcpApprovalExpired({
        expiresAt: existing.context?.expiresAt,
        createdAt: existing.createdAt,
        ttlMs: resolveMcpApprovalTtlMs(runtime.readEnvironment),
      })) {
    const receipt = buildBlockedActionReceipt({
      approvalId: existing.id,
      workspaceId: existing.workspaceId || 'default',
      actor: existing.context?.provenance?.actor || 'mcp',
      actionType: existing.tool,
      toolName: canonicalMcpToolName(existing.tool),
      requestedVerdict: existing.decision || 'review',
      reason: 'mcp_approval_expired',
    });
    return failApprovalDecision(
      'APPROVAL_EXPIRED',
      'This approval has expired; it can no longer be approved and must be requested again.',
      { approval: existing, receipt, retrySafe: false },
    );
  }

  const oversightRequired = existing.context?.oversightRequired === true;
  const oversightRuntime = getHumanOversightRuntime(runtime);
  if (oversightRequired && !oversightRuntime) {
    return failApprovalDecision('OVERSIGHT_RUNTIME_UNAVAILABLE', 'This approval requires the configured Human Oversight runtime.', { approval: existing, retrySafe: false });
  }
  const storedArgs = existing.context?.args && typeof existing.context.args === 'object'
    ? existing.context.args
    : parseJsonObject(existing.input, {});
  const canonicalTool = canonicalMcpToolName(existing.tool);
  // A row whose arguments drifted from the ones its reviewer was shown is not
  // executed (#3488). This is a consistency check, not a seal: see
  // lib/mcp-call-binding.js. Rows written before bindings existed carry none.
  const reviewedBinding = existing.policy?.reviewedBinding;
  if (decision === 'approved' && reviewedBinding
      && !reviewedArgsHold(reviewedBinding, canonicalTool, existing, input => parseJsonObject(input, null))) {
    return failApprovalDecision(
      'APPROVAL_BINDING_MISMATCH',
      'The stored call no longer matches the reviewed tool and arguments; execution is blocked.',
      { approval: existing, retrySafe: false },
    );
  }
  const oversightCase = oversightRequired
    ? readMcpOversightCase({ runtime, approval: existing, toolName: canonicalTool, storedArgs, gate: existing.policy?.gate || {} })
    : { enabled: false, ok: true };
  if (oversightRequired && !oversightCase.ok) {
    return failApprovalDecision('OVERSIGHT_CASE_UNAVAILABLE', 'The durable Human Oversight review case could not be read; execution is blocked.', { approval: existing, retrySafe: false });
  }
  const identityEvaluation = oversightRequired && decision === 'approved'
    ? evaluateMcpAgentIdentity({ runtime, oversightInput: oversightCase.input })
    : { enabled: false, ok: true };
  if (identityEvaluation.enabled && !identityEvaluation.ok) {
    return failApprovalDecision(
      'IDENTITY_ENFORCEMENT_BLOCKED',
      'Receiver-owned Agent Identity evaluation blocked the approved MCP action; execution is not allowed.',
      {
        approval: existing,
        identity: identityEvaluation.evidence,
        retrySafe: false,
      },
    );
  }

  if (existing.tool === 'http.ingest') {
    return decideMcpIngestApproval({
      kernel,
      approvalStore,
      approvalId,
      workspaceId,
      decision,
      reason,
      runtime,
      fail: failApprovalDecision,
    });
  }

  if (decision === 'rejected') {
    const oversightDecision = oversightRequired
      ? decideMcpOversight({ runtime, oversightCase, approval: existing, args, decision })
      : { enabled: false, ok: true };
    if (oversightRequired && !oversightDecision.ok) {
      return failApprovalDecision('OVERSIGHT_DECISION_FAILED', 'The durable Human Oversight rejection could not be recorded.', { approval: existing, retrySafe: false });
    }
    const rejection = approvalStore.rejectToolApproval(approvalId, reason, workspaceId);
    if (!rejection || rejection.rejected !== true) {
      const current = formatApprovalRecord(rejection?.approval || approvalStore.getToolApprovalById(approvalId, workspaceId));
      return failApprovalDecision(
        'APPROVAL_DECISION_CONFLICT',
        'Approval is already claimed or is not pending.',
        { approval: current, retrySafe: false },
      );
    }
    const rejected = formatApprovalRecord(rejection.approval);
    return {
      ok: true,
      type: 'approval',
      data: {
        approval: rejected,
        decision,
        executed: false,
        idempotent: false,
        result: null,
        ...(oversightDecision.enabled ? { oversight: oversightSummary(oversightCase.result, oversightDecision.result) } : {}),
        ...(identityEvaluation.enabled ? { identity: identityEvaluation.evidence } : {}),
      },
      evidence: [],
      error: null,
      meta: {},
    };
  }

  if (canonicalTool === 'huqan.agent_repair') {
    // #3151: an approved repair resumes the paused run automatically.
    return executeApprovedRepair({
      kernel, approvalStore, approval: existing, approvalId, workspaceId, reason, decision, fail: failApprovalDecision, tool: canonicalTool,
      ...(runtime.createRepairAgent ? { createRepairAgent: runtime.createRepairAgent } : {}),
    });
  }

  if (canonicalTool === 'huqan.agent') {
    return executeApprovedMcpAgent({
      kernel,
      approvalStore,
      approval: existing,
      approvalId,
      workspaceId,
      reason,
      decision,
      cleanArgs: sanitizeToolArgsForStorage(existing.tool, storedArgs),
      fail: failApprovalDecision,
    });
  }

  // Canonicalized rather than compared literally: approvals persisted before
  // the RFC-001 rename carry `tool: "axiom.learn"`, and those rows must stay
  // executable. Comparing the raw string would have silently made every
  // pre-rename pending approval permanently unapprovable.
  if (canonicalTool !== 'huqan.learn') {
    return failApprovalDecision('APPROVAL_EXECUTION_UNSUPPORTED', `Approval execution is only supported for huqan.learn, huqan.agent and huqan.agent_repair, got ${existing.tool}.`, { approval: existing });
  }

  // Learn execution lives in lib/mcp-approval-learn-execution.js (#2207):
  // claim, run through oversight or directly, then finalize with receipt.
  return executeApprovedLearn({
    kernel,
    approvalStore,
    approvalId,
    workspaceId,
    reason,
    decision,
    existing,
    storedArgs,
    oversightRequired,
    runtime,
    oversightCase,
    oversightRuntime,
    identityEvaluation,
    args,
    failApprovalDecision,
  });
}


function createMcpApprovalDecisionHandler({ failApprovalDecision }) {
  if (typeof failApprovalDecision !== 'function') {
    throw new TypeError('failApprovalDecision function is required');
  }
  return (kernel, args = {}, runtime = {}) =>
    handleMcpApprovalDecision(kernel, args, runtime, failApprovalDecision);
}

module.exports = {
  createMcpApprovalDecisionHandler,
  getHumanOversightRuntime,
  createMcpOversightCase,
};
