'use strict';

// Oversight input building for the MCP approval surface (#2306, moved
// verbatim from lib/mcp-human-oversight-adapter.js): canonical hashing,
// bounded context/risk helpers and buildMcpOversightInput, which turns an
// approval into the frozen oversight input the review cases consume.

const crypto = require('crypto');
const { ProvenanceError } = require('./errors/provenance-error');
const { AGENT_ACTION_FIREWALL_VERSION } = require('./agent-action-firewall');
const { buildApprovalAdmissionOptions } = require('./mcp-approval-admission');
const { isPlainObject } = require('./is-plain-object');

const DEFAULT_POLICY_VERSION = 'mcp-approval-v1';
const CASE_PREFIX = 'mcp-oversight:';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function hashValue(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function boundedRiskScore(value) {
  const score = Number(value);
  return Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0;
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
  // #2592: a declared external-agent instruction with no caller-supplied
  // provenance never gets a review case -- approving it would bless an origin
  // nobody can audit. Both oversight choke points (create/read) catch this
  // and refuse execution through the existing unavailable-case path.
  if (admission.agentOriginUnproven) {
    throw new ProvenanceError('agent origin requires caller-supplied provenanceId and sourceRef');
  }
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
  const riskScore = boundedRiskScore(
    gate.risk?.score
      ?? gate.riskScore
      ?? gate.metadata?.riskScore
      ?? approval?.policy?.gate?.riskScore,
  );
  const action = {
    actionFingerprint,
    // #3486 (R31): bind the decision to the reviewed argument summary.
    argsDigest: inputHash,
    workspaceId,
    connectorRef: `mcp:${toolName}`,
    resourceRef,
    policyVersion,
    firewallVersion,
    requestedVerdict,
    riskScore,
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

module.exports = Object.freeze({
  CASE_PREFIX,
  DEFAULT_POLICY_VERSION,
  buildMcpOversightInput,
  buildApproverContext,
  boundedContext,
  boundedRiskScore,
  canonicalize,
  contextResolver,
  hashValue,
});

