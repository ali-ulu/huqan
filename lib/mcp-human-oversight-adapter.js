'use strict';

const crypto = require('crypto');
const { AGENT_ACTION_FIREWALL_VERSION } = require('./agent-action-firewall');
const { buildApprovalAdmissionOptions } = require('./mcp-approval-admission');

const DEFAULT_POLICY_VERSION = 'mcp-approval-v1';
const CASE_PREFIX = 'mcp-oversight:';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
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
  if (typeof resolver === 'function') {
    const resolved = resolver(details);
    return boundedContext(resolved);
  }
  if (resolver !== undefined) return boundedContext(resolver);
  if (typeof runtime?.humanOversightContextResolver === 'function') {
    return boundedContext(runtime.humanOversightContextResolver({ role, ...details }));
  }
  return null;
}

function buildMcpOversightInput({ approval, toolName, storedArgs = {}, gate = {}, runtime = {} } = {}) {
  const admission = buildApprovalAdmissionOptions(approval, storedArgs);
  const gateMetadata = isPlainObject(approval?.policy?.gate?.metadata)
    ? approval.policy.gate.metadata
    : (isPlainObject(gate.metadata) ? gate.metadata : {});
  const workspaceId = admission.workspaceId;
  const policyVersion = String(gateMetadata.policyVersion || gateMetadata.adapterVersion || DEFAULT_POLICY_VERSION);
  const firewallVersion = String(gateMetadata.firewallVersion || AGENT_ACTION_FIREWALL_VERSION);
  const approvalId = String(approval?.id || '');
  const approvalKey = String(approval?.approvalKey || approvalId);
  const provenance = admission.admissionContext.provenance || {};
  const resourceRef = approvalKey;
  const target = String(provenance.sourceRef || approvalKey);
  const inputHash = hashValue(storedArgs);
  const actionFingerprint = `mcp-action:${hashValue({
    approvalId,
    toolName,
    workspaceId,
    inputHash,
    policyVersion,
    firewallVersion,
  })}`;
  const requestedVerdict = ['review', 'dry_run_only', 'block'].includes(gate.decision)
    ? gate.decision
    : (['review', 'dry_run_only', 'block'].includes(approval?.policy?.gate?.decision)
      ? approval.policy.gate.decision
      : 'review');
  const action = {
    actionFingerprint,
    workspaceId,
    connectorRef: `mcp:${toolName}`,
    resourceRef,
    policyVersion,
    firewallVersion,
    requestedVerdict,
    requestedEffect: `execute:${toolName}`,
    actionType: 'mcp_tool_call',
    toolName,
    target,
    agentId: '',
    evidenceRefs: [approvalId, admission.admissionContext.candidateId || ''].filter(Boolean),
    provenanceRefs: [admission.admissionContext.provenanceId, target].filter(Boolean),
    evidenceDigest: hashValue({ actionFingerprint, workspaceId, inputHash }),
  };
  const requesterDetails = {
    approvalId,
    approvalKey,
    workspaceId,
    admissionContext: admission.admissionContext,
    action,
  };
  return Object.freeze({
    caseId: `${CASE_PREFIX}${approvalId}`,
    action: Object.freeze(action),
    requesterContext: contextResolver(runtime, 'requester', requesterDetails),
    firewallRequest: Object.freeze({
      surface: 'mcp-approval',
      tool: toolName,
      action: 'learn',
      context: Object.freeze({ workspaceId, approvalId, source: 'mcp-approval' }),
    }),
    admissionOptions: admission,
  });
}

function buildApproverContext(runtime, details) {
  return contextResolver(runtime, 'approver', details);
}

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

module.exports = Object.freeze({
  CASE_PREFIX,
  buildMcpOversightInput,
  buildApproverContext,
  oversightSummary,
});

// Keep the adapter’s identity context surface intentionally narrow: it accepts
// receiver-supplied context, never request payload identity claims.
