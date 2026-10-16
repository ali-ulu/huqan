'use strict';

// HTTP ingest human oversight adapter: opens, decides and executes an
// oversight case. Input building lives in http-human-oversight-adapter-input.js,
// identity evaluation in http-human-oversight-adapter-identity.js (#2220).

const { evaluateHttpAgentIdentity, identityEvidence } = require('./http-human-oversight-adapter-identity');
const { CASE_PREFIX, buildHttpApproverContext, buildHttpIngestOversightInput } = require('./http-human-oversight-adapter-input');

function getHumanOversightRuntime(config = {}) {
  const runtime = config?.runtime || config?.humanOversightApprovalRuntime;
  return runtime && typeof runtime.createReviewCase === 'function'
    && typeof runtime.getReviewCase === 'function'
    && typeof runtime.decide === 'function'
    && typeof runtime.executeApproved === 'function'
    ? runtime
    : null;
}

function isHttpIngestOversightRequired(approval) {
  return approval?.context?.oversightRequired === true;
}

function createHttpIngestOversightCase({ approval, humanOversight = {} } = {}) {
  if (!isHttpIngestOversightRequired(approval)) return { enabled: false, ok: true };
  const runtime = getHumanOversightRuntime(humanOversight);
  if (!runtime) return { enabled: true, ok: false, reason: 'oversight_runtime_unavailable' };
  try {
    const input = buildHttpIngestOversightInput({ approval, runtime: humanOversight });
    const result = runtime.createReviewCase({
      caseId: input.caseId,
      action: input.action,
      firewallDecision: input.action.requestedVerdict,
      requesterContext: input.requesterContext,
      policy: { requireApproverDistinct: true, policyBasisRef: input.action.policyVersion },
      metadata: { source: 'http-ingest-approval', approvalId: approval.id, approvalKey: approval.approvalKey },
    });
    if (!result || result.ok !== true) return { enabled: true, ok: false, result, input };
    return { enabled: true, ok: true, input, result, runtime, runtimeOptions: humanOversight, summary: oversightSummary(result) };
  } catch (error) {
    return { enabled: true, ok: false, error: error?.message || 'oversight_case_creation_failed' };
  }
}

function decideHttpIngestOversight({ approval, decision, reason = '', oversightCase } = {}) {
  if (!oversightCase?.enabled) return { enabled: false, ok: true };
  if (!oversightCase.ok || !oversightCase.runtime || !oversightCase.input) {
    return { enabled: true, ok: false, reason: 'oversight_case_unavailable', case: oversightCase };
  }
  const decisionType = decision === 'approved' ? 'approve' : 'reject';
  try {
    const result = oversightCase.runtime.decide({
      caseId: oversightCase.input.caseId,
      decisionType,
      approverContext: buildHttpApproverContext(oversightCase.runtimeOptions || {}, {
        approvalId: approval.id,
        approvalKey: approval.approvalKey,
        caseId: oversightCase.input.caseId,
        decision: decisionType,
        reason,
      }),
      reason: reason || `http_ingest_${decisionType}`,
      evidenceDigest: oversightCase.input.action.evidenceDigest,
    });
    return { enabled: true, ok: Boolean(result?.ok), result, case: oversightCase };
  } catch (error) {
    return { enabled: true, ok: false, reason: error?.message || 'oversight_decision_failed', case: oversightCase };
  }
}

function prepareHttpIngestOversightDecision({ approval, decision, reason = '', humanOversight = null } = {}) {
  const oversightCase = isHttpIngestOversightRequired(approval)
    ? createHttpIngestOversightCase({ approval, humanOversight })
    : { enabled: false, ok: true };
  if (oversightCase.enabled && !oversightCase.ok) {
    return {
      ok: false,
      oversightCase,
      oversightDecision: { enabled: true, ok: false },
      identityEvaluation: { enabled: false, ok: true },
      failureCode: 'REVIEW_CASE_NOT_PERSISTED',
    };
  }
  let identityEvaluation = { enabled: false, ok: true };
  if (decision === 'approved' && humanOversight?.agentIdentityRuntime !== undefined) {
    try {
      const input = oversightCase.input || buildHttpIngestOversightInput({ approval, runtime: humanOversight });
      identityEvaluation = evaluateHttpAgentIdentity({ runtime: humanOversight, oversightInput: input });
    } catch (_) {
      const result = { decision: 'block', allowed: false, reason: 'identity.evaluation_failed' };
      identityEvaluation = { enabled: true, ok: false, result, evidence: identityEvidence(result) };
    }
    if (!identityEvaluation.ok) {
      return {
        ok: false,
        oversightCase,
        oversightDecision: { enabled: oversightCase.enabled, ok: false },
        identityEvaluation,
        failureCode: 'IDENTITY_ENFORCEMENT_BLOCKED',
      };
    }
  }
  if (!oversightCase.enabled) {
    return {
      ok: true,
      oversightCase,
      oversightDecision: { enabled: false, ok: true },
      identityEvaluation,
    };
  }
  const oversightDecision = decideHttpIngestOversight({ approval, decision, reason, oversightCase });
  return {
    ok: oversightDecision.ok,
    oversightCase,
    oversightDecision,
    identityEvaluation,
    failureCode: 'OVERSIGHT_DECISION_FAILED',
  };
}

function httpOversightFailure(preparation) {
  const code = preparation?.failureCode || 'OVERSIGHT_DECISION_FAILED';
  const status = code === 'REVIEW_CASE_NOT_PERSISTED' ? 503 : 409;
  const message = code === 'IDENTITY_ENFORCEMENT_BLOCKED'
    ? 'Receiver-owned Agent Identity evaluation blocked the approved HTTP ingest action; execution is not allowed.'
    : status === 503
      ? 'Human Oversight review case is unavailable; approval decision is blocked.'
      : 'The durable Human Oversight approval could not be recorded; execution is blocked.';
  return {
    status,
    code,
    message,
    details: preparation?.identityEvaluation?.enabled
      ? { identity: preparation.identityEvaluation.evidence }
      : {},
  };
}

async function executeHttpIngestWithOversight({ oversightCase, action, requesterContext, firewallRequest, execute }) {
  if (!oversightCase?.enabled) return { ok: true, result: await execute(), execution: null };
  const execution = await oversightCase.runtime.executeApproved({
    caseId: oversightCase.input.caseId,
    action,
    requesterContext,
    firewallRequest,
    executor: execute,
  });
  if (!execution || execution.ok !== true) {
    return { ok: false, result: null, execution, failureCode: 'OVERSIGHT_EXECUTION_BLOCKED' };
  }
  return { ok: true, result: execution.result || null, execution };
}

function oversightSummary(caseResult, decisionResult, executionResult) {
  const record = executionResult?.execution?.case || executionResult?.case || decisionResult?.case || caseResult?.case;
  return Object.freeze({
    caseId: record?.caseId || caseResult?.case?.caseId || '',
    status: record?.status || '',
    decisionId: decisionResult?.decision?.decisionId || record?.latestDecisionId || '',
    decisionType: decisionResult?.decision?.decisionType || record?.latestDecisionType || '',
    caseReceiptId: caseResult?.receipt?.receiptId || caseResult?.case?.creationReceiptId || '',
    decisionReceiptId: decisionResult?.receipt?.receiptId || decisionResult?.decision?.receiptId || '',
    executionReceiptId: executionResult?.execution?.receipt?.receiptId || executionResult?.execution?.receiptId || '',
    reason: String(executionResult?.reason || executionResult?.execution?.reason || decisionResult?.reason || '').slice(0, 160),
  });
}

module.exports = Object.freeze({
  CASE_PREFIX,
  buildHttpIngestOversightInput,
  buildHttpApproverContext,
  oversightSummary,
  getHumanOversightRuntime,
  isHttpIngestOversightRequired,
  createHttpIngestOversightCase,
  decideHttpIngestOversight,
  prepareHttpIngestOversightDecision,
  executeHttpIngestWithOversight,
  evaluateHttpAgentIdentity,
  identityEvidence,
  httpOversightFailure,
});
