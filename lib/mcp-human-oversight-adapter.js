'use strict';

const crypto = require('crypto');
const { AGENT_ACTION_FIREWALL_VERSION } = require('./agent-action-firewall');
const { buildApprovalAdmissionOptions } = require('./mcp-approval-admission');
const {
  composeReceiverOwnedIdentityClaim,
  evaluateAgentIdentity,
  AGENT_IDENTITY_RUNTIME_VERSION,
} = require('./agent-identity-runtime');

const DEFAULT_POLICY_VERSION = 'mcp-approval-v1';
const CASE_PREFIX = 'mcp-oversight:';

const { isPlainObject } = require('./is-plain-object');

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

function identityEvidence(result) {
  const identity = result?.identity;
  const delegation = result?.delegation;
  return Object.freeze({
    version: String(result?.version || AGENT_IDENTITY_RUNTIME_VERSION),
    decision: result?.decision === 'allow' ? 'allow' : 'block',
    allowed: result?.allowed === true,
    reason: String(result?.reason || 'identity.evaluation_failed').slice(0, 160),
    evaluatedAt: typeof result?.evaluatedAt === 'string' ? result.evaluatedAt : null,
    identity: identity && typeof identity === 'object'
      ? Object.freeze({
        agentId: String(identity.agentId || ''),
        identityRef: String(identity.identityRef || ''),
        identityHash: String(identity.identityHash || ''),
        workspaceId: String(identity.workspaceId || ''),
        ownerActorId: String(identity.ownerActorId || ''),
        trustTier: String(identity.trustTier || ''),
        riskTier: String(identity.riskTier || ''),
      })
      : null,
    delegation: delegation && typeof delegation === 'object'
      ? Object.freeze({
        chainDigest: hashValue(Array.isArray(delegation.chain) ? delegation.chain : []),
        scope: Object.freeze(Array.isArray(delegation.scope) ? delegation.scope.slice(0, 64).map(String) : []),
      })
      : null,
  });
}

function evaluateMcpAgentIdentity({ runtime = {}, oversightInput } = {}) {
  const config = runtime?.agentIdentityRuntime;
  if (config === undefined || config === null) return { enabled: false, ok: true };
  try {
    if (!isPlainObject(config) || !isPlainObject(config.action)) {
      return {
        enabled: true,
        ok: false,
        result: { decision: 'block', allowed: false, reason: 'identity.evaluation_failed' },
        evidence: identityEvidence({ decision: 'block', allowed: false, reason: 'identity.evaluation_failed' }),
      };
    }
    const action = Object.freeze({
      ...config.action,
      target: String(oversightInput?.action?.target || ''),
      tool: String(oversightInput?.action?.toolName || ''),
    });
    const receiver = config.receiver || {
      subject: oversightInput?.requesterContext?.subject,
      kind: oversightInput?.requesterContext?.kind || 'mcp-approval',
      workspaceId: oversightInput?.action?.workspaceId,
    };
    if (oversightInput?.requesterContext?.subject
        && receiver?.subject !== oversightInput.requesterContext.subject) {
      const result = { decision: 'block', allowed: false, reason: 'identity.claim_binding_mismatch' };
      return { enabled: true, ok: false, result, evidence: identityEvidence(result) };
    }
    if (receiver?.workspaceId !== oversightInput?.action?.workspaceId) {
      const result = { decision: 'block', allowed: false, reason: 'identity.workspace_mismatch' };
      return { enabled: true, ok: false, result, evidence: identityEvidence(result) };
    }
    const composition = composeReceiverOwnedIdentityClaim({
      authority: config.authority,
      identityRef: config.identityRef,
      receiver: {
        subject: receiver?.subject,
        kind: receiver?.kind,
        workspaceId: receiver?.workspaceId,
      },
    });
    if (!composition.allowed) {
      return { enabled: true, ok: false, result: composition, evidence: identityEvidence(composition) };
    }
    const result = evaluateAgentIdentity({
      authority: config.authority,
      claim: composition.claim,
      action,
    });
    return {
      enabled: true,
      ok: result.allowed === true,
      result,
      evidence: identityEvidence(result),
    };
  } catch (_) {
    const result = { decision: 'block', allowed: false, reason: 'identity.evaluation_failed' };
    return { enabled: true, ok: false, result, evidence: identityEvidence(result) };
  }
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
  evaluateMcpAgentIdentity,
  identityEvidence,
  oversightSummary,
});

// Keep the adapter’s identity context surface intentionally narrow: it accepts
// receiver-supplied context, never request payload identity claims.
