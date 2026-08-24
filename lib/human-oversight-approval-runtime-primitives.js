'use strict';

const { stableStringify, sha256Hex } = require('./receipt/canonical-receipt');
const {
  AGENT_ACTION_FIREWALL_DECISIONS,
  evaluateAgentActionFirewall,
} = require('./agent-action-firewall');
const {
  TRUST_EVIDENCE_SCHEMA_VERSION,
  buildTrustEvidencePayload,
} = require('./trust-evidence-ledger');

const HUMAN_OVERSIGHT_RUNTIME_VERSION = 'human-oversight-approval-runtime-v1';
const REVIEW_CASE_SCHEMA_VERSION = 'huqan-review-case-v1';
const APPROVAL_DECISION_SCHEMA_VERSION = 'huqan-approval-decision-v1';
const STATE_RECORD_SCHEMA_VERSION = 'huqan-human-oversight-state-v1';

const DECISION_TYPES = Object.freeze([
  'approve',
  'reject',
  'expire',
  'cancel',
  'escalate',
  'override',
]);

const CASE_STATUSES = Object.freeze([
  'pending',
  'escalated',
  'approved',
  'rejected',
  'expired',
  'cancelled',
  'blocked',
  'executed',
  'reconciliation_required',
]);

const EXECUTION_OUTCOMES = Object.freeze([
  'not_attempted',
  'dry_run_only',
  'succeeded',
  'failed',
  'unknown',
]);

const MAX_TEXT = 512;
const MAX_REASON = 1024;
const MAX_REFS = 32;
const MAX_HISTORY = 128;
const MAX_METADATA_BYTES = 4096;
const DEFAULT_CASE_LIFETIME_MS = 15 * 60 * 1000;
const MAX_CASE_LIFETIME_MS = 24 * 60 * 60 * 1000;

const RUNTIME_REASONS = Object.freeze({
  DURABILITY_UNAVAILABLE: 'approval.durable_state_unavailable',
  CASE_NOT_FOUND: 'approval.case_not_found',
  CASE_IMMUTABLE_MISMATCH: 'approval.case_immutable_mismatch',
  MALFORMED_CASE: 'approval.case_malformed',
  MALFORMED_DECISION: 'approval.decision_malformed',
  DECISION_REASON_REQUIRED: 'approval.decision_reason_required',
  APPROVER_IDENTITY_REQUIRED: 'approval.approver_identity_required',
  REQUESTER_IDENTITY_REQUIRED: 'approval.requester_identity_required',
  IDENTITY_REJECTED: 'approval.identity_rejected',
  SELF_APPROVAL_REJECTED: 'approval.self_approval_rejected',
  SCOPE_MISMATCH: 'approval.scope_mismatch',
  POLICY_MISMATCH: 'approval.policy_mismatch',
  FIREWALL_MISMATCH: 'approval.firewall_mismatch',
  ACTION_MISMATCH: 'approval.action_mismatch',
  CASE_EXPIRED: 'approval.case_expired',
  CASE_NOT_PENDING: 'approval.case_not_pending',
  DUPLICATE_OR_AMBIGUOUS_DECISION: 'approval.duplicate_or_ambiguous_decision',
  OVERRIDE_NOT_AUTHORIZED: 'approval.override_not_authorized',
  BLOCKED_BY_FIREWALL: 'approval.firewall_blocked',
  DRY_RUN_EXECUTOR_BLOCKED: 'approval.dry_run_executor_blocked',
  APPROVAL_REQUIRED: 'approval.valid_approval_required',
  EXECUTION_RECORDED_AS_UNKNOWN: 'approval.execution_outcome_unknown',
  EXECUTION_RECONCILIATION_REQUIRED: 'approval.execution_reconciliation_required',
  RESOLVER_FAILED: 'approval.identity_resolver_failed',
  FIREWALL_EVALUATION_FAILED: 'approval.firewall_evaluation_failed',
  APPROVAL_COOLDOWN_ACTIVE: 'approval.cooldown_active',
  QUORUM_DISTINCT_APPROVER_REQUIRED: 'approval.quorum_distinct_approver_required',
});

const { isPlainObject } = require('./is-plain-object');

function cloneJson(value, field) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    throw new TypeError(`${field} must be JSON-serializable`);
  }
}

function boundedText(value, field, { required = false, max = MAX_TEXT } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new TypeError(`${field} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`);
  const normalized = value.trim();
  if (required && !normalized) throw new TypeError(`${field} is required`);
  if (normalized.length > max) throw new TypeError(`${field} exceeds bounded length`);
  return normalized;
}

function boundedRefs(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_REFS) throw new TypeError(`${field} must be a bounded array`);
  return value.map((item, index) => boundedText(item, `${field}[${index}]`));
}

function safeMetadata(value) {
  const metadata = value === undefined ? {} : cloneJson(value, 'metadata');
  if (!isPlainObject(metadata)) throw new TypeError('metadata must be an object');
  const forbidden = /prompt|input|content|token|secret|credential|password|private.?key/i;
  function visit(node, depth, path) {
    if (depth > 4) throw new TypeError(`${path} exceeds nested depth`);
    if (Array.isArray(node)) {
      if (node.length > MAX_REFS) throw new TypeError(`${path} exceeds bounded array length`);
      node.forEach((child, index) => visit(child, depth + 1, `${path}[${index}]`));
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      if (forbidden.test(key)) throw new TypeError(`forbidden metadata field: ${path}.${key}`);
      visit(child, depth + 1, `${path}.${key}`);
    }
  }
  visit(metadata, 0, 'metadata');
  if (Buffer.byteLength(stableStringify(metadata), 'utf8') > MAX_METADATA_BYTES) {
    throw new TypeError('metadata exceeds bounded size');
  }
  return metadata;
}

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

function caseOperationId(caseId) {
  return `human-oversight:review-case:create:${caseId}`;
}

function decisionOperationPrefix(caseId) {
  return `human-oversight:approval-decision:${caseId}:`;
}

function decisionOperationId(caseId, decisionId) {
  return `${decisionOperationPrefix(caseId)}${decisionId}`;
}

function outcomeOperationId(caseId, outcomeId) {
  return `human-oversight:execution-outcome:${caseId}:${outcomeId}`;
}

function buildLedgerEvent({ workspaceId, operationId, caseRecord, eventType, decisionType, reason, createdAt, metadata = {}, executionOutcome = 'not_attempted' }) {
  const verdict = verdictForEvent(eventType, decisionType);
  return {
    workspaceId,
    operationId,
    decision: verdict,
    reason: boundedText(reason, 'reason', { max: MAX_REASON }),
    actionFingerprint: caseRecord.actionFingerprint,
    identityRef: caseRecord.requester.identityRef,
    identityHash: caseRecord.requester.identityHash,
    authorityRef: caseRecord.requester.authorityRef,
    delegationRef: caseRecord.requester.delegationRef,
    policyVersion: caseRecord.policyVersion,
    firewallVersion: caseRecord.firewallVersion,
    connectorRef: caseRecord.connectorRef,
    resourceRef: caseRecord.resourceRef,
    approvalRef: caseRecord.caseId,
    executionOutcome,
    sourceRefs: caseRecord.evidenceRefs,
    provenanceRefs: caseRecord.provenanceRefs,
    createdAt,
    metadata: safeMetadata({
      runtimeVersion: HUMAN_OVERSIGHT_RUNTIME_VERSION,
      schemaVersion: TRUST_EVIDENCE_SCHEMA_VERSION,
      eventType,
      decisionType,
      reviewCaseId: caseRecord.caseId,
      requestedVerdict: caseRecord.requestedVerdict,
      ...metadata,
    }),
  };
}


module.exports = Object.freeze({
  HUMAN_OVERSIGHT_RUNTIME_VERSION,
  REVIEW_CASE_SCHEMA_VERSION,
  APPROVAL_DECISION_SCHEMA_VERSION,
  STATE_RECORD_SCHEMA_VERSION,
  DECISION_TYPES,
  CASE_STATUSES,
  EXECUTION_OUTCOMES,
  MAX_TEXT,
  MAX_REASON,
  MAX_REFS,
  MAX_HISTORY,
  MAX_METADATA_BYTES,
  DEFAULT_CASE_LIFETIME_MS,
  MAX_CASE_LIFETIME_MS,
  RUNTIME_REASONS,
  isPlainObject,
  cloneJson,
  boundedText,
  boundedRefs,
  safeMetadata,
  nowMillis,
  isoAt,
  parseInstant,
  hashObject,
  makeId,
  freezeClone,
  fail,
  validFirewallDecision,
  normalizeIdentity,
  normalizeAction,
  normalizePolicy,
  caseOperationId,
  decisionOperationPrefix,
  decisionOperationId,
  outcomeOperationId,
  buildLedgerEvent,
  AGENT_ACTION_FIREWALL_DECISIONS,
  evaluateAgentActionFirewall,
  TRUST_EVIDENCE_SCHEMA_VERSION,
  buildTrustEvidencePayload,
});
