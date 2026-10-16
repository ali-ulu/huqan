'use strict';

// #2220: agent identity evidence for an HTTP ingest oversight case, and its
// evaluation against the runtime's identity authority.

const { composeReceiverOwnedIdentityClaim, evaluateAgentIdentity, AGENT_IDENTITY_RUNTIME_VERSION } = require('./agent-identity-runtime');
const { isPlainObject } = require('./is-plain-object');
const { hashValue } = require('./http-human-oversight-adapter-input');

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

function evaluateHttpAgentIdentity({ runtime = {}, oversightInput } = {}) {
  const config = runtime?.agentIdentityRuntime;
  if (config === undefined || config === null) return { enabled: false, ok: true };
  try {
    if (!isPlainObject(config) || !isPlainObject(config.action)) {
      const result = { decision: 'block', allowed: false, reason: 'identity.evaluation_failed' };
      return { enabled: true, ok: false, result, evidence: identityEvidence(result) };
    }
    const action = Object.freeze({
      ...config.action,
      target: String(oversightInput?.action?.target || ''),
      tool: String(oversightInput?.action?.toolName || 'http.ingest'),
      connector: String(oversightInput?.action?.connectorRef || 'http:ingest'),
    });
    const receiver = config.receiver || {
      subject: oversightInput?.requesterContext?.subject,
      kind: oversightInput?.requesterContext?.kind || 'http-ingest-approval',
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
    return { enabled: true, ok: result.allowed === true, result, evidence: identityEvidence(result) };
  } catch (_) {
    const result = { decision: 'block', allowed: false, reason: 'identity.evaluation_failed' };
    return { enabled: true, ok: false, result, evidence: identityEvidence(result) };
  }
}

module.exports = {
  evaluateHttpAgentIdentity,
  identityEvidence,
};
