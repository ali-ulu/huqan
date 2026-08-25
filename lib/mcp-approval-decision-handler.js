'use strict';

const {
  MCP_MAX_TEXT,
  MCP_MAX_SHORT,
  sanitizeMcpString,
  sanitizeMcpApprovalDecision,
  sanitizeToolArgsForStorage,
} = require('./mcp-input-sanitizers');
const { createApprovalStoreFromKernel } = require('./mcp-approval-store');
const { buildApprovalAdmissionOptions } = require('./mcp-approval-admission');
const {
  buildMcpOversightInput,
  buildApproverContext,
  evaluateMcpAgentIdentity,
  oversightSummary,
} = require('./mcp-human-oversight-adapter');
const { canonicalMcpToolName } = require('./mcp-tool-names');
const { parseJsonObject } = require('./json-object');
const { formatApprovalRecord } = require('./mcp-approval-views');
const { decideMcpIngestApproval } = require('./mcp-ingest-execute-tool');
const { idempotentApprovalDecision, finalizeApprovalExecution } = require('./approval-execution-evidence');
const { executeApprovedMcpAgent } = require('./mcp-agent-approval-execution');

function getHumanOversightRuntime(runtime = {}) {
  const oversight = runtime.humanOversightApprovalRuntime;
  return oversight && typeof oversight.createReviewCase === 'function'
    && typeof oversight.getReviewCase === 'function'
    && typeof oversight.decide === 'function'
    && typeof oversight.executeApproved === 'function'
    ? oversight
    : null;
}

function createMcpOversightCase({ runtime, approval, toolName, storedArgs, gate }) {
  const oversight = getHumanOversightRuntime(runtime);
  if (!oversight || toolName !== 'huqan.learn') return { enabled: false, ok: true };
  let input;
  try {
    input = buildMcpOversightInput({ approval, toolName, storedArgs, gate, runtime });
    const result = oversight.createReviewCase({
      caseId: input.caseId,
      action: input.action,
      firewallDecision: input.action.requestedVerdict,
      requesterContext: input.requesterContext,
      policy: { requireApproverDistinct: true, policyBasisRef: input.action.policyVersion },
      metadata: { source: 'mcp-approval', approvalId: approval.id, approvalKey: approval.approvalKey },
    });
    if (!result || result.ok !== true) {
      return { enabled: true, ok: false, result, input };
    }
    return { enabled: true, ok: true, input, result, summary: oversightSummary(result) };
  } catch (error) {
    return { enabled: true, ok: false, error: error?.message || 'oversight_case_creation_failed', input };
  }
}

function readMcpOversightCase({ runtime, approval, toolName, storedArgs, gate }) {
  const oversight = getHumanOversightRuntime(runtime);
  if (!oversight || toolName !== 'huqan.learn') return { enabled: false, ok: true };
  try {
    const input = buildMcpOversightInput({ approval, toolName, storedArgs, gate, runtime });
    const result = oversight.getReviewCase(input.caseId);
    return { enabled: true, ok: Boolean(result?.ok), input, result };
  } catch (error) {
    return { enabled: true, ok: false, error: error?.message || 'oversight_case_read_failed' };
  }
}

function decideMcpOversight({ runtime, oversightCase, approval, args, decision }) {
  const oversight = getHumanOversightRuntime(runtime);
  if (!oversight || !oversightCase?.input) return { enabled: false, ok: true };
  const decisionType = decision === 'approved' ? 'approve' : 'reject';
  const result = oversight.decide({
    caseId: oversightCase.input.caseId,
    decisionType,
    approverContext: buildApproverContext(runtime, {
      approvalId: approval.id,
      approvalKey: approval.approvalKey,
      caseId: oversightCase.input.caseId,
      decision: decisionType,
      reason: args.reason || '',
    }),
    reason: args.reason || `mcp_${decisionType}`,
    evidenceDigest: oversightCase.input.action.evidenceDigest,
  });
  return { enabled: true, ok: Boolean(result?.ok), result };
}

function handleMcpApprovalDecision(kernel, args = {}, runtime = {}, failApprovalDecision) {
  const approvalStore = runtime.approvalStore || createApprovalStoreFromKernel(kernel, runtime);
  if (!approvalStore ||
      typeof approvalStore.getToolApprovalById !== 'function' ||
      typeof approvalStore.claimToolApproval !== 'function' ||
      typeof approvalStore.rejectToolApproval !== 'function' ||
      typeof approvalStore.failToolApproval !== 'function' ||
      typeof approvalStore.finalizeToolApprovalWithReceipt !== 'function') {
    return failApprovalDecision('APPROVAL_STORE_UNAVAILABLE', 'Persistent MCP approval store is unavailable.');
  }

  const approvalId = sanitizeMcpString(args.approvalId, MCP_MAX_SHORT);
  if (!approvalId) {
    return failApprovalDecision('APPROVAL_ID_REQUIRED', 'approvalId is required.');
  }
  const workspaceId = sanitizeMcpString(args.workspaceId, MCP_MAX_SHORT) || 'default';

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

  const oversightRequired = existing.context?.oversightRequired === true;
  const oversightRuntime = getHumanOversightRuntime(runtime);
  if (oversightRequired && !oversightRuntime) {
    return failApprovalDecision('OVERSIGHT_RUNTIME_UNAVAILABLE', 'This approval requires the configured Human Oversight runtime.', { approval: existing, retrySafe: false });
  }
  const storedArgs = existing.context?.args && typeof existing.context.args === 'object'
    ? existing.context.args
    : parseJsonObject(existing.input, {});
  const canonicalTool = canonicalMcpToolName(existing.tool);
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
    return failApprovalDecision('APPROVAL_EXECUTION_UNSUPPORTED', `Approval execution is only supported for huqan.learn and huqan.agent, got ${existing.tool}.`, { approval: existing });
  }

  const claim = approvalStore.claimToolApproval(approvalId, reason, workspaceId);
  if (!claim || claim.claimed !== true) {
    const current = formatApprovalRecord(claim?.approval || approvalStore.getToolApprovalById(approvalId, workspaceId));
    if (current?.status === 'approved') {
      return idempotentApprovalDecision(current, decision);
    }
    const code = current?.status === 'failed'
      ? 'APPROVAL_RECONCILIATION_REQUIRED'
      : current?.status === 'executing'
        ? 'APPROVAL_EXECUTION_IN_PROGRESS'
        : 'APPROVAL_DECISION_CONFLICT';
    return failApprovalDecision(
      code,
      current?.status === 'failed'
        ? 'Approval execution outcome is unknown and requires manual reconciliation.'
        : 'Approval execution is already claimed or is not pending.',
      { approval: current, retrySafe: false },
    );
  }

  const cleanArgs = sanitizeToolArgsForStorage(existing.tool, storedArgs);
  const learnOptions = buildApprovalAdmissionOptions(existing, cleanArgs);
  const oversightDecision = oversightRequired
    ? decideMcpOversight({ runtime, oversightCase, approval: existing, args, decision })
    : { enabled: false, ok: true };
  if (oversightRequired && !oversightDecision.ok) {
    const failure = approvalStore.failToolApproval(approvalId, 'oversight_decision_failed', workspaceId);
    return failApprovalDecision('OVERSIGHT_DECISION_FAILED', 'The durable Human Oversight approval could not be recorded; execution is blocked.', {
      approval: formatApprovalRecord(failure?.approval || approvalStore.getToolApprovalById(approvalId, workspaceId)),
      retrySafe: false,
    });
  }
  if (kernel.graph && typeof kernel.graph.runMutationOnce === 'function') {
    learnOptions.mutationOperationId = approvalId;
  }
  const completeExecution = (result, oversightExecution = null) => {
    if (!result || result.ok === false) {
      const failure = approvalStore.failToolApproval(approvalId, 'execution_outcome_unknown:result_not_ok', workspaceId);
      const failed = formatApprovalRecord(failure?.approval || approvalStore.getToolApprovalById(approvalId, workspaceId));
      return failApprovalDecision(
        'APPROVAL_EXECUTION_FAILED',
        'Approved MCP action failed; outcome requires manual reconciliation.',
        { approval: failed, result, retrySafe: false },
      );
    }

    let finalization;
    try {
      finalization = finalizeApprovalExecution({ store: approvalStore, approvalId, workspaceId, reason, graph: kernel.graph, result });
    } catch (error) {
      return failApprovalDecision('APPROVAL_FINALIZATION_FAILED', 'Approved MCP action executed but finalizing the approval record threw an error.', {
        approval: formatApprovalRecord(approvalStore.getToolApprovalById(approvalId, workspaceId)), result, retrySafe: false,
        finalizationError: error?.code || error?.name || 'error',
      });
    }
    if (finalization.code) {
      const failure = approvalStore.failToolApproval(approvalId, 'execution_outcome_unknown:receipt_not_materialized', workspaceId);
      return failApprovalDecision(finalization.code, 'Approved MCP action executed but its canonical receipt could not be materialized.',
        { approval: formatApprovalRecord(failure?.approval || approvalStore.getToolApprovalById(approvalId, workspaceId)), result, retrySafe: false },
      );
    }
    const approved = formatApprovalRecord(finalization.approval);
    const executionEvidence = finalization.executionEvidence;
    if (!approved || approved.status !== 'approved') {
      return failApprovalDecision(
        'APPROVAL_FINALIZATION_FAILED',
        'Approved MCP action executed but the approval record could not be finalized.',
        { approval: approved || formatApprovalRecord(approvalStore.getToolApprovalById(approvalId, workspaceId)), result, retrySafe: false },
      );
    }
    return {
      ok: true,
      type: 'approval',
      data: {
        approval: approved,
        decision,
        executed: true,
        idempotent: false,
        result,
        receipt: executionEvidence.receipt,
        refs: executionEvidence.refs,
        ...(oversightRequired ? { oversight: oversightSummary(oversightCase.result, oversightDecision.result, oversightExecution) } : {}),
        ...(identityEvaluation.enabled ? { identity: identityEvaluation.evidence } : {}),
      },
      evidence: result.evidence || [],
      error: null,
      meta: { admissionAware: true },
    };
  };

  if (oversightRequired) {
    return Promise.resolve().then(() => oversightRuntime.executeApproved({
      caseId: oversightCase.input.caseId,
      action: oversightCase.input.action,
      requesterContext: oversightCase.input.requesterContext,
      firewallRequest: oversightCase.input.firewallRequest,
      executor: () => kernel.learn(cleanArgs.text, learnOptions),
    })).then((oversightExecution) => {
      if (!oversightExecution || oversightExecution.ok !== true) {
        const failure = approvalStore.failToolApproval(approvalId, 'execution_outcome_unknown:oversight_runtime_blocked', workspaceId);
        return failApprovalDecision('OVERSIGHT_EXECUTION_BLOCKED', 'Human Oversight revalidation blocked the approved action; outcome requires manual reconciliation.', {
          approval: formatApprovalRecord(failure?.approval || approvalStore.getToolApprovalById(approvalId, workspaceId)),
          oversight: oversightSummary(oversightCase.result, oversightDecision.result, oversightExecution),
          retrySafe: false,
        });
      }
      return completeExecution(oversightExecution.result, oversightExecution);
    }).catch((error) => {
      const failure = approvalStore.failToolApproval(
        approvalId,
        `execution_outcome_unknown:${error?.code || error?.name || 'error'}`,
        workspaceId,
      );
      return failApprovalDecision(
        'APPROVAL_EXECUTION_FAILED',
        'Approved MCP action threw during Human Oversight execution; outcome requires manual reconciliation.',
        { approval: formatApprovalRecord(failure?.approval || approvalStore.getToolApprovalById(approvalId, workspaceId)), retrySafe: false },
      );
    });
  }

  let result;
  try {
    result = kernel.learn(cleanArgs.text, learnOptions);
  } catch (error) {
    const failure = approvalStore.failToolApproval(
      approvalId,
      `execution_outcome_unknown:${error?.code || error?.name || 'error'}`,
      workspaceId,
    );
    const failed = formatApprovalRecord(failure?.approval || approvalStore.getToolApprovalById(approvalId, workspaceId));
    return failApprovalDecision(
      'APPROVAL_EXECUTION_FAILED',
      'Approved MCP action threw during execution; outcome requires manual reconciliation.',
      { approval: failed, retrySafe: false },
    );
  }
  return completeExecution(result);
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
