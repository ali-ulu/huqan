'use strict';

// #2219: clock, hashing and id helpers, the firewall verdict mapping, and the
// normalization of the identity, action and policy a review case opens with.

const { AGENT_ACTION_FIREWALL_DECISIONS } = require('./agent-action-firewall');
const { isPlainObject } = require('./is-plain-object');
const { MAX_REASON, RUNTIME_REASONS, boundedRefs, boundedText, cloneJson, sha256Hex, stableStringify } = require('./human-oversight-approval-runtime-primitives-values');

function nowMillis(clock) {
  try {
    const value = Number(clock());
    return Number.isFinite(value) ? value : null;
  } catch (_) {
    return null;
  }
}

function isoAt(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function parseInstant(value, field) {
  const text = boundedText(value, field, { required: true });
  const time = Date.parse(text);
  if (!Number.isFinite(time)) throw new TypeError(`${field} must be a timestamp`);
  return { text, time };
}

function hashObject(value) {
  return sha256Hex(stableStringify(value));
}

function makeId(prefix, value) {
  return `${prefix}:${sha256Hex(stableStringify(value)).slice(0, 32)}`;
}

function freezeClone(value) {
  return Object.freeze(cloneJson(value, 'runtime result'));
}

function fail(reason, details = {}) {
  return Object.freeze({ ok: false, allowed: false, decision: 'block', reason, details: freezeClone(details) });
}

function validFirewallDecision(value) {
  return Object.values(AGENT_ACTION_FIREWALL_DECISIONS).includes(value);
}

function verdictForEvent(eventType, decisionType) {
  if (eventType === 'review_case_created') return decisionType;
  if (decisionType === 'approve' || decisionType === 'override') return 'allow';
  if (decisionType === 'escalate') return 'review';
  return 'block';
}

function normalizeIdentity(identityResult, role, workspaceId) {
  if (!identityResult || identityResult.decision !== 'allow' || !identityResult.identity) {
    return { ok: false, reason: RUNTIME_REASONS.IDENTITY_REJECTED };
  }
  const identity = identityResult.identity;
  try {
    const identityRef = boundedText(identity.identityRef, `${role}.identityRef`, { required: true });
    const identityHash = boundedText(identity.identityHash, `${role}.identityHash`, { required: true });
    const resolvedWorkspaceId = boundedText(identity.workspaceId, `${role}.workspaceId`, { required: true });
    if (resolvedWorkspaceId !== workspaceId) return { ok: false, reason: RUNTIME_REASONS.SCOPE_MISMATCH };
    return {
      ok: true,
      identity: {
        identityRef,
        identityHash,
        workspaceId: resolvedWorkspaceId,
        agentId: boundedText(identity.agentId, `${role}.agentId`),
        ownerActorId: boundedText(identity.ownerActorId, `${role}.ownerActorId`),
        authorityRef: boundedText(identity.authorityRef, `${role}.authorityRef`),
      },
    };
  } catch (_) {
    return { ok: false, reason: role === 'approver' ? RUNTIME_REASONS.APPROVER_IDENTITY_REQUIRED : RUNTIME_REASONS.REQUESTER_IDENTITY_REQUIRED };
  }
}

function normalizeAction(action = {}) {
  if (!isPlainObject(action)) throw new TypeError('action must be an object');
  const normalized = {
    actionFingerprint: boundedText(action.actionFingerprint, 'actionFingerprint', { required: true }),
    workspaceId: boundedText(action.workspaceId, 'workspaceId', { required: true }),
    connectorRef: boundedText(action.connectorRef, 'connectorRef'),
    resourceRef: boundedText(action.resourceRef, 'resourceRef'),
    policyVersion: boundedText(action.policyVersion, 'policyVersion', { required: true }),
    firewallVersion: boundedText(action.firewallVersion, 'firewallVersion', { required: true }),
    requestedVerdict: boundedText(action.requestedVerdict, 'requestedVerdict', { required: true }),
    requestedEffect: boundedText(action.requestedEffect, 'requestedEffect', { required: true, max: MAX_REASON }),
    actionType: boundedText(action.actionType, 'actionType'),
    toolName: boundedText(action.toolName, 'toolName'),
    target: boundedText(action.target, 'target'),
    agentId: boundedText(action.agentId, 'agentId'),
    evidenceRefs: boundedRefs(action.evidenceRefs, 'evidenceRefs'),
    provenanceRefs: boundedRefs(action.provenanceRefs, 'provenanceRefs'),
    evidenceDigest: boundedText(action.evidenceDigest, 'evidenceDigest'),
    riskScore: Number(action.riskScore ?? 0),
  };
  if (!validFirewallDecision(normalized.requestedVerdict)) {
    throw new TypeError('requestedVerdict must be a canonical firewall decision');
  }
  if (!Number.isFinite(normalized.riskScore) || normalized.riskScore < 0 || normalized.riskScore > 100) {
    throw new TypeError('riskScore must be a number between 0 and 100');
  }
  if (!['review', 'dry_run_only', 'block'].includes(normalized.requestedVerdict)) {
    throw new TypeError('review case requires review, dry_run_only, or block');
  }
  if (!normalized.evidenceDigest) {
    normalized.evidenceDigest = hashObject({ evidenceRefs: normalized.evidenceRefs, provenanceRefs: normalized.provenanceRefs });
  }
  return normalized;
}

function normalizePolicy(policy = {}) {
  const source = isPlainObject(policy) ? policy : {};
  return {
    requireApproverDistinct: source.requireApproverDistinct !== false,
    allowSelfApproval: source.allowSelfApproval === true,
    allowOverride: source.allowOverride === true,
    approvalRequired: source.approvalRequired !== false,
    approvalCooldownMs: Number.isInteger(source.approvalCooldownMs) && source.approvalCooldownMs >= 0
      ? Math.min(source.approvalCooldownMs, 24 * 60 * 60 * 1000) : 30_000,
    criticalRiskScore: Number.isFinite(Number(source.criticalRiskScore))
      ? Math.max(0, Math.min(100, Number(source.criticalRiskScore))) : 80,
    requiredApprovers: Number.isInteger(source.requiredApprovers) && source.requiredApprovers >= 1
      ? Math.min(source.requiredApprovers, 8) : 2,
    policyBasisRef: boundedText(source.policyBasisRef, 'policyBasisRef'),
  };
}

module.exports = {
  fail,
  freezeClone,
  hashObject,
  isoAt,
  makeId,
  normalizeAction,
  normalizeIdentity,
  normalizePolicy,
  nowMillis,
  parseInstant,
  validFirewallDecision,
  verdictForEvent,
};
