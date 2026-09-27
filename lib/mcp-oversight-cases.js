'use strict';

// Oversight review-case plumbing for the MCP approval surface (#2306, moved
// verbatim from lib/mcp-human-oversight-adapter.js): create/read/decide only
// make sense next to buildMcpOversightInput, which builds everything they
// pass into the human oversight runtime.

const {
  buildMcpOversightInput,
  buildApproverContext,
} = require('./mcp-oversight-input');

function oversightSummary(caseResult, decisionResult, executionResult) {
  const record = executionResult?.execution?.case || executionResult?.case || decisionResult?.case || caseResult?.case;
  return {
    caseId: record?.caseId || caseResult?.case?.caseId || '',
    status: record?.status || '',
    decisionId: decisionResult?.decision?.decisionId || record?.latestDecisionId || '',
    decisionType: decisionResult?.decision?.decisionType || record?.latestDecisionType || '',
    caseReceiptId: caseResult?.receipt?.receiptId || caseResult?.case?.creationReceiptId || '',
    decisionReceiptId: decisionResult?.receipt?.receiptId || decisionResult?.decision?.receiptId || '',
    executionReceiptId: executionResult?.execution?.receipt?.receiptId || executionResult?.execution?.receiptId || '',
    reason: String(executionResult?.reason || executionResult?.execution?.reason || decisionResult?.reason || '').slice(0, 160),
  };
}

/**
 * Oversight review-case plumbing, moved verbatim from
 * lib/mcp-approval-decision-handler.js (#2207): create/read/decide only make
 * sense next to buildMcpOversightInput, which builds everything they pass.
 */
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

module.exports = Object.freeze({
  oversightSummary,
  getHumanOversightRuntime,
  createMcpOversightCase,
  readMcpOversightCase,
  decideMcpOversight,
});

