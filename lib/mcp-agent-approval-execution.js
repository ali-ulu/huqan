'use strict';

const crypto = require('crypto');
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

function buildAgentExecutionEvidence({ approval, approvalId, workspaceId, args, result, now = Date.now() }) {
  const inputHash = sha256(JSON.stringify(canonicalize(args || {})));
  const data = result && typeof result.data === 'object' && result.data ? result.data : {};
  const outcome = String(data.status || (result?.ok === false ? 'blocked' : 'completed'));
  const checkpointId = String(data.checkpointId || result?.meta?.checkpointId || '');
  const runId = String(data.observabilityRunId || data.runId || '');
  const receiptCore = {
    schemaVersion: AGENT_EXECUTION_RECEIPT_SCHEMA,
    receiptId: `mcp-agent-${sha256(`${approvalId}:${inputHash}`).slice(0, 32)}`,
    approvalId: String(approvalId),
    approvalKey: String(approval?.approvalKey || approval?.approval_key || ''),
    workspaceId: String(workspaceId || 'default'),
    tool: 'huqan.agent',
    inputHash,
    outcome,
    checkpointId: checkpointId || null,
    runId: runId || null,
    executedAt: new Date(now).toISOString(),
  };
  const receipt = {
    ...receiptCore,
    receiptHash: sha256(JSON.stringify(canonicalize(receiptCore))),
  };
  return {
    receipt,
    refs: {
      approvalId: String(approvalId),
      checkpointId: checkpointId || null,
      runId: runId || null,
    },
  };
}

function executeApprovedMcpAgent({
  approvalStore,
  approval,
  approvalId,
  workspaceId,
  reason,
  decision,
  cleanArgs,
  runtime,
  fail,
}) {
  if (!runtime || typeof runtime.executeApprovedAgent !== 'function') {
    return fail(
      'APPROVED_AGENT_EXECUTOR_UNAVAILABLE',
      'Approved huqan.agent execution is unavailable in this runtime.',
      { approval, retrySafe: false },
    );
  }

  const claim = approvalStore.claimToolApproval(approvalId, reason, workspaceId);
  if (!claim || claim.claimed !== true) {
    const current = formatApprovalRecord(
      claim?.approval || approvalStore.getToolApprovalById(approvalId, workspaceId),
    );
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
    });
    let finalized;
    try {
      finalized = approvalStore.finalizeToolApprovalWithReceipt(approvalId, {
        expectedStatus: 'executing',
        decision: 'approved',
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
    if (!finalized?.finalized || !approved || approved.status !== 'approved') {
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
    execution = runtime.executeApprovedAgent(cleanArgs, {
      approvalId,
      workspaceId,
      approval,
    });
  } catch (error) {
    return failExecution(error);
  }

  if (execution && typeof execution.then === 'function') {
    return execution.then(complete, failExecution);
  }
  return complete(execution);
}

module.exports = {
  AGENT_EXECUTION_RECEIPT_SCHEMA,
  buildAgentExecutionEvidence,
  executeApprovedMcpAgent,
};
