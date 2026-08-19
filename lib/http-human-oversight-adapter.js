'use strict';

const crypto = require('node:crypto');
const { AGENT_ACTION_FIREWALL_VERSION } = require('./agent-action-firewall');

const DEFAULT_POLICY_VERSION = 'http-ingest-approval-v1';
const CASE_PREFIX = 'http-ingest-oversight:';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

function hashValue(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function boundedContext(value) {
  if (!isPlainObject(value)) return null;
  return Object.freeze({ ...value });
}

function contextResolver(runtime, role, details) {
  const resolver = role === 'requester'
    ? runtime?.humanOversightRequesterContext
    : runtime?.humanOversightApproverContext;
  if (typeof resolver === 'function') return boundedContext(resolver(details));
  if (resolver !== undefined) return boundedContext(resolver);
  if (typeof runtime?.humanOversightContextResolver === 'function') {
    return boundedContext(runtime.humanOversightContextResolver({ role, ...details }));
  }
  return null;
}

function buildHttpIngestOversightInput({ approval, runtime = {} } = {}) {
  const snapshot = approval?.context?.snapshot;
  const approvalId = String(approval?.id || '').trim();
  const approvalKey = String(approval?.approvalKey || approvalId).trim();
  const workspaceId = String(snapshot?.workspaceId || approval?.context?.workspaceId || '').trim();
  if (!approvalId || !workspaceId || !isPlainObject(snapshot)) {
    throw new TypeError('HTTP ingest approval snapshot is required for Human Oversight');
  }

  const sourceType = String(snapshot.sourceType || '').trim();
  const sourceRef = String(snapshot.sourceRef || approvalKey).trim();
  const snapshotHash = String(snapshot.snapshotHash || '').trim();
  const inputHash = snapshotHash || hashValue({
    workspaceId,
    sourceType,
    sourceRef,
    idempotencyKey: String(snapshot.idempotencyKey || '').trim(),
  });
  const policyVersion = String(
    approval?.policy?.gate?.metadata?.policyVersion
      || approval?.policy?.approvalVersion
      || DEFAULT_POLICY_VERSION,
  ).slice(0, 160);
  const firewallVersion = String(
    approval?.policy?.gate?.metadata?.firewallVersion || AGENT_ACTION_FIREWALL_VERSION,
  ).slice(0, 160);
  const actionFingerprint = `http-ingest-action:${hashValue({
    approvalId,
    approvalKey,
    workspaceId,
    inputHash,
    policyVersion,
    firewallVersion,
  })}`;
  const action = {
    actionFingerprint,
    workspaceId,
    connectorRef: 'http:ingest',
    resourceRef: approvalKey,
    policyVersion,
    firewallVersion,
    requestedVerdict: 'review',
    requestedEffect: 'execute:http.ingest',
    actionType: 'http_ingest_approval',
    toolName: 'http.ingest',
    target: sourceRef,
    agentId: '',
    evidenceRefs: [approvalId, snapshotHash].filter(Boolean),
    provenanceRefs: [sourceRef].filter(Boolean),
    evidenceDigest: hashValue({ actionFingerprint, workspaceId, inputHash }),
  };
  const requesterDetails = {
    approvalId,
    approvalKey,
    workspaceId,
    snapshotHash,
    sourceType,
    sourceRef,
    action,
  };
  return Object.freeze({
    caseId: `${CASE_PREFIX}${approvalId}`,
    action: Object.freeze(action),
    requesterContext: contextResolver(runtime, 'requester', requesterDetails),
    firewallRequest: Object.freeze({
      surface: 'http-ingest-approval',
      tool: 'http.ingest',
      action: 'ingest',
      context: Object.freeze({ workspaceId, approvalId, source: 'http-ingest-approval' }),
    }),
  });
}

function buildHttpApproverContext(runtime, details) {
  return contextResolver(runtime, 'approver', details);
}

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
    return { ok: false, oversightCase, oversightDecision: { enabled: true, ok: false }, failureCode: 'REVIEW_CASE_NOT_PERSISTED' };
  }
  if (!oversightCase.enabled) return { ok: true, oversightCase, oversightDecision: { enabled: false, ok: true } };
  const oversightDecision = decideHttpIngestOversight({ approval, decision, reason, oversightCase });
  return {
    ok: oversightDecision.ok,
    oversightCase,
    oversightDecision,
    failureCode: 'OVERSIGHT_DECISION_FAILED',
  };
}

function httpOversightFailure(preparation) {
  const status = preparation?.failureCode === 'REVIEW_CASE_NOT_PERSISTED' ? 503 : 409;
  const message = status === 503
    ? 'Human Oversight review case is unavailable; approval decision is blocked.'
    : 'The durable Human Oversight approval could not be recorded; execution is blocked.';
  return { status, code: preparation?.failureCode || 'OVERSIGHT_DECISION_FAILED', message };
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
  httpOversightFailure,
});
