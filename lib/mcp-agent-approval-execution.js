'use strict';

const crypto = require('crypto');
const { createAgent } = require('../agentRuntime');
const { evaluateMcpGate } = require('./mcp-gate-adapter');
const { restoreAgentReview } = require('./human-approval-toggle');
const {
  MCP_MAX_GOAL,
  sanitizeMcpString,
  boundedMcpInteger,
} = require('./mcp-input-sanitizers');
const { formatApprovalRecord } = require('./mcp-approval-views');

const AGENT_EXECUTION_RECEIPT_SCHEMA = 'mcp-agent-approval-execution-v1';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonicalize(value[key])]),
  );
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/**
 * What an emergency stop cut short (#3878): the steps that finished before it
 * and the one it stopped. Steps that finished keep their effects -- nothing is
 * rolled back, and the receipt says so rather than leaving it implied.
 */
function cancellationOf(data) {
  if (data.terminationReason !== 'emergency_stop') return null;
  const steps = Array.isArray(data.steps) ? data.steps : [];
  const stopped = steps.find(step => step?.result?.error?.code === 'AGENT_EMERGENCY_STOPPED');
  const stop = stopped?.result?.meta?.emergencyStop || {};
  return {
    completedSteps: steps.filter(step => step?.status === 'done').map(step => String(step.id)),
    stoppedBeforeStep: stopped ? String(stopped.id) : null,
    stopScope: stop.scope || null,
    stopTarget: stop.target || null,
    sideEffectsRolledBack: false,
  };
}

function buildAgentExecutionEvidence({ approval, approvalId, workspaceId, args, result, now = Date.now(), tool = 'huqan.agent' }) {
  const inputHash = sha256(JSON.stringify(canonicalize(args || {})));
  const data = result && typeof result.data === 'object' && result.data ? result.data : {};
  const cancellation = cancellationOf(data);
  const outcome = cancellation ? 'cancelled' : String(data.status || (result?.ok === false ? 'blocked' : 'completed'));
  const checkpointId = String(data.checkpointId || result?.meta?.checkpointId || '');
  const runId = String(data.observabilityRunId || data.runId || '');
  const receiptCore = {
    schemaVersion: AGENT_EXECUTION_RECEIPT_SCHEMA,
    receiptId: `mcp-agent-${sha256(`${approvalId}:${inputHash}`).slice(0, 32)}`,
    approvalId: String(approvalId),
    approvalKey: String(approval?.approvalKey || approval?.approval_key || ''),
    workspaceId: String(workspaceId || 'default'),
    tool,
    inputHash,
    outcome,
    checkpointId: checkpointId || null,
    runId: runId || null,
    executedAt: new Date(now).toISOString(),
    ...(cancellation ? { cancellation } : {}),
  };
  const receipt = {
    ...receiptCore,
    receiptHash: sha256(JSON.stringify(canonicalize(receiptCore))),
  };
  return {
    receipt,
    cancelled: cancellation !== null,
    refs: {
      approvalId: String(approvalId),
      checkpointId: checkpointId || null,
      runId: runId || null,
    },
  };
}

function revalidateApprovedAgent(cleanArgs, kernel = null) {
  return restoreAgentReview(evaluateMcpGate({
    tool: 'huqan.agent',
    args: cleanArgs,
    metadata: {},
  }, { plugins: kernel?.plugins, kernel }));
}

function runApprovedAgent(kernel, cleanArgs, workspaceId, approvalId) {
  const agent = createAgent({ kernel });
  const closeStorage = () => {
    try { agent?.storage?.close?.(); } catch (_) {}
  };
  let result;
  try {
    result = agent.run(sanitizeMcpString(cleanArgs.goal, MCP_MAX_GOAL), {
      maxSteps: boundedMcpInteger(cleanArgs.maxSteps, 4, 1, 8),
      workspaceId,
      // #3878: lets an approval-scoped emergency stop reach this run's steps.
      approvalId,
    });
  } catch (error) {
    closeStorage();
    throw error;
  }
  if (result && typeof result.then === 'function') {
    return result.then(
      value => { closeStorage(); return value; },
      error => { closeStorage(); throw error; },
    );
  }
  closeStorage();
  return result;
}

function executeApprovedMcpAgent({
  kernel,
  approvalStore,
  approval,
  approvalId,
  workspaceId,
  reason,
  decision,
  cleanArgs,
  fail,
  executeAgent = null,
  receiptTool = 'huqan.agent',
}) {
  const revalidatedGate = revalidateApprovedAgent(cleanArgs, kernel);
  if (!revalidatedGate || !['allow', 'review'].includes(revalidatedGate.decision)) {
    return fail(
      'APPROVED_AGENT_REVALIDATION_BLOCKED',
      'Approved huqan.agent call no longer passes current MCP policy; execution was not claimed or started.',
      { approval, gate: revalidatedGate || null, retrySafe: false },
    );
  }

  const claim = approvalStore.claimToolApproval(approvalId, reason, workspaceId);
  if (!claim || claim.claimed !== true) {
    const current = formatApprovalRecord(
      claim?.approval || approvalStore.getToolApprovalById(approvalId, workspaceId),
    );
    if (current?.status === 'cancelled') {
      return fail(
        'APPROVAL_ALREADY_CANCELLED',
        'This approved execution was cancelled by an emergency stop; it does not run again.',
        { approval: current, receipt: current.context?.receipt || null, retrySafe: false },
      );
    }
    if (current?.status === 'approved') {
      return {
        ok: true,
        type: 'approval',
        data: {
          approval: current,
          decision,
          executed: false,
          idempotent: true,
          result: null,
          receipt: current.context?.receipt || null,
          refs: current.context?.executionRefs || null,
        },
        evidence: [],
        error: null,
        meta: { idempotent: true },
      };
    }
    const code = current?.status === 'failed'
      ? 'APPROVAL_RECONCILIATION_REQUIRED'
      : current?.status === 'executing'
        ? 'APPROVAL_EXECUTION_IN_PROGRESS'
        : 'APPROVAL_DECISION_CONFLICT';
    return fail(
      code,
      current?.status === 'failed'
        ? 'Approval execution outcome is unknown and requires manual reconciliation.'
        : 'Approval execution is already claimed or is not pending.',
      { approval: current, retrySafe: false },
    );
  }

  const failExecution = (error) => {
    const failure = approvalStore.failToolApproval(
      approvalId,
      `execution_outcome_unknown:${error?.code || error?.name || 'error'}`,
      workspaceId,
    );
    return fail(
      'APPROVAL_EXECUTION_FAILED',
      'Approved huqan.agent call threw during execution; outcome requires manual reconciliation.',
      {
        approval: formatApprovalRecord(
          failure?.approval || approvalStore.getToolApprovalById(approvalId, workspaceId),
        ),
        retrySafe: false,
        executionError: error?.code || error?.name || 'error',
      },
    );
  };

  const complete = (result) => {
    if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
      return failExecution(Object.assign(new Error('invalid_agent_execution_result'), { code: 'INVALID_AGENT_EXECUTION_RESULT' }));
    }

    const executionEvidence = buildAgentExecutionEvidence({
      approval,
      approvalId,
      workspaceId,
      args: cleanArgs,
      result,
      tool: receiptTool,
    });
    const finalStatus = executionEvidence.cancelled ? 'cancelled' : 'approved';
    let finalized;
    try {
      finalized = approvalStore.finalizeToolApprovalWithReceipt(approvalId, {
        expectedStatus: 'executing',
        // A run an emergency stop cut short is cancelled, not approved (#3878).
        decision: finalStatus,
        reason,
        workspaceId,
        receipt: executionEvidence.receipt,
        contextPatch: { executionRefs: executionEvidence.refs },
      });
    } catch (error) {
      const failure = approvalStore.failToolApproval(
        approvalId,
        'execution_outcome_unknown:approval_finalization_failed',
        workspaceId,
      );
      return fail(
        'APPROVAL_FINALIZATION_FAILED',
        'Approved huqan.agent call executed but its approval receipt could not be finalized.',
        {
          approval: formatApprovalRecord(
            failure?.approval || approvalStore.getToolApprovalById(approvalId, workspaceId),
          ),
          result,
          retrySafe: false,
          finalizationError: error?.code || error?.name || 'error',
        },
      );
    }

    const approved = formatApprovalRecord(finalized?.approval);
    if (!finalized?.finalized || !approved || approved.status !== finalStatus) {
      const failure = approvalStore.failToolApproval(
        approvalId,
        'execution_outcome_unknown:approval_finalization_unconfirmed',
        workspaceId,
      );
      return fail(
        'APPROVAL_FINALIZATION_FAILED',
        'Approved huqan.agent call executed but the approval record could not be finalized.',
        {
          approval: formatApprovalRecord(
            failure?.approval || approvalStore.getToolApprovalById(approvalId, workspaceId),
          ),
          result,
          retrySafe: false,
        },
      );
    }

    return {
      ok: true,
      type: 'approval',
      data: {
        approval: approved,
        decision,
        executed: true,
        ...(executionEvidence.cancelled ? { cancelled: true } : {}),
        idempotent: false,
        result,
        receipt: executionEvidence.receipt,
        refs: executionEvidence.refs,
      },
      evidence: Array.isArray(result.evidence) ? result.evidence : [],
      error: null,
      meta: { agentApproval: true },
    };
  };

  let execution;
  try {
    execution = typeof executeAgent === 'function'
      ? executeAgent(cleanArgs, { approvalId, workspaceId, approval })
      : runApprovedAgent(kernel, cleanArgs, workspaceId, approvalId);
  } catch (error) {
    return failExecution(error);
  }

  if (execution && typeof execution.then === 'function') {
    return execution.then(complete, failExecution);
  }
  return complete(execution);
}

/** The agent an approval executes on, bound to the given store. Exported so
 * the repair executor (#3151) builds its agent through the one approval module
 * that already composes the runtime, instead of reaching up to it itself. */
function createApprovalAgent(kernel, storage) {
  return createAgent({ kernel, storage });
}

module.exports = {
  createApprovalAgent,
  AGENT_EXECUTION_RECEIPT_SCHEMA,
  buildAgentExecutionEvidence,
  executeApprovedMcpAgent,
  revalidateApprovedAgent,
};
