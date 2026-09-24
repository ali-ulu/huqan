'use strict';

// #2223: agent identity runtime version, record/claim/action/authority keys,
// limits and errors, the snapshot registry, exact-shape readers, the
// allow/block results and identity record validation.

const crypto = require('node:crypto');
const { stableStringify } = require('./receipt/canonical-receipt');

function canonicalHash(value) {
  return crypto.createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

const AGENT_IDENTITY_RUNTIME_VERSION = 'agent-identity-runtime-0-v1';
const RISK_ORDER = Object.freeze({ low: 0, medium: 1, high: 2, critical: 3 });
const IDENTITY_REQUIRED_KEYS = Object.freeze([
  'agent_id', 'agent_type', 'display_name', 'owner_actor_id', 'workspace_id',
  'delegation_scope', 'allowed_tools', 'allowed_memory_scopes',
  'allowed_connectors', 'risk_tier', 'trust_tier', 'policy_version', 'issued_at',
  'expires_at', 'revoked_at', 'revocation_reason', 'parent_agent_id',
  'delegation_chain', 'receipt_refs', 'provenance_refs', 'audit_requirements',
  'verification_status', 'expected_status', 'expected_reason_code',
]);
const IDENTITY_CLAIM_KEYS = Object.freeze([
  'agentId', 'identityRef', 'identityHash', 'workspaceId', 'delegationChain',
]);
const ACTION_KEYS = Object.freeze([
  'capability', 'target', 'riskTier', 'tool', 'connector',
]);
const AUTHORITY_KEYS = Object.freeze(['workspaceId', 'identities', 'clock']);
const RECEIVER_BINDING_KEYS = Object.freeze(['subject', 'kind', 'workspaceId']);
const SNAPSHOTS = new WeakSet();
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_LIST_ITEMS = 64;
const MAX_STRING_BYTES = 1024;

const IDENTITY_RUNTIME_ERRORS = Object.freeze({
  AUTHORITY_REQUIRED: 'identity.authority_required',
  AUTHORITY_INVALID: 'identity.authority_invalid',
  CLAIM_INVALID: 'identity.invalid_claim',
  IDENTITY_UNKNOWN: 'identity.unknown',
  IDENTITY_HASH_INVALID: 'identity.hash_invalid',
  WORKSPACE_MISMATCH: 'identity.workspace_mismatch',
  NOT_YET_VALID: 'identity.not_yet_valid',
  EXPIRED: 'identity.expired',
  REVOKED: 'identity.revoked',
  VERIFICATION_INVALID: 'identity.verification_invalid',
  DELEGATION_CHAIN_INVALID: 'delegation.chain_invalid',
  DELEGATION_SCOPE_EXCEEDED: 'delegation.scope_exceeded',
  CAPABILITY_NOT_ALLOWED: 'action.capability_not_allowed',
  TOOL_NOT_ALLOWED: 'action.tool_not_allowed',
  CONNECTOR_NOT_ALLOWED: 'action.connector_not_allowed',
  RISK_TIER_EXCEEDED: 'action.risk_tier_exceeded',
  TARGET_INVALID: 'action.target_invalid',
  EVALUATION_FAILED: 'identity.evaluation_failed',
});

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactObject(value, keys) {
  if (!plain(value)) return false;
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== 'string')) return false;
  const expected = [...keys].sort();
  if ([...actual].sort().join('\\0') !== expected.join('\\0')) return false;
  return actual.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value')
      && !descriptor.get && !descriptor.set;
  });
}

function text(value) {
  return typeof value === 'string' && value.length > 0
    && value.trim() === value && Buffer.byteLength(value, 'utf8') <= MAX_STRING_BYTES;
}

function stringList(value, { allowEmpty = false } = {}) {
  return Array.isArray(value)
    && value.length <= MAX_LIST_ITEMS
    && (allowEmpty || value.length > 0)
    && value.every(text)
    && new Set(value).size === value.length;
}

function instant(value) {
  return typeof value === 'string' && INSTANT.test(value) && Number.isFinite(Date.parse(value));
}

function snapshot(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) snapshot(child);
  return Object.freeze(value);
}

function block(reason, details = {}) {
  return Object.freeze({
    version: AGENT_IDENTITY_RUNTIME_VERSION,
    decision: 'block',
    allowed: false,
    reason,
    details: Object.freeze({ ...details }),
  });
}

function allow(identity, claim, action, evaluatedAt) {
  return Object.freeze({
    version: AGENT_IDENTITY_RUNTIME_VERSION,
    decision: 'allow',
    allowed: true,
    reason: 'ok',
    evaluatedAt,
    identity: Object.freeze({
      agentId: identity.agent_id,
      agentType: identity.agent_type,
      identityRef: claim.identityRef,
      identityHash: claim.identityHash,
      workspaceId: claim.workspaceId,
      ownerActorId: identity.owner_actor_id,
      trustTier: identity.trust_tier,
      riskTier: identity.risk_tier,
    }),
    delegation: Object.freeze({
      chain: Object.freeze([...claim.delegationChain]),
      scope: Object.freeze([...identity.delegation_scope]),
    }),
    action: Object.freeze({ ...action }),
  });
}

function validateIdentityRecord(record) {
  if (!exactObject(record, IDENTITY_REQUIRED_KEYS)) return false;
  for (const key of ['agent_id', 'agent_type', 'display_name', 'owner_actor_id',
    'workspace_id', 'risk_tier', 'trust_tier', 'policy_version',
    'verification_status', 'expected_status']) {
    if (!text(record[key])) return false;
  }
  for (const key of ['delegation_scope', 'allowed_tools', 'allowed_memory_scopes',
    'allowed_connectors', 'receipt_refs', 'provenance_refs', 'audit_requirements']) {
    if (!stringList(record[key], { allowEmpty: key !== 'delegation_scope' })) return false;
  }
  if (!stringList(record.delegation_chain, { allowEmpty: true })
      || !Object.hasOwn(RISK_ORDER, record.risk_tier)
      || !instant(record.issued_at) || !instant(record.expires_at)
      || record.revoked_at !== null || record.revocation_reason !== null
      || ![null, ...record.delegation_chain].includes(record.parent_agent_id)
      || !['valid', 'registered'].includes(record.verification_status)
      || record.expected_status !== 'valid' || record.expected_reason_code !== null) return false;
  return true;
}

function readNow(clock) {
  try {
    const value = clock();
    return Number.isFinite(value) ? value : null;
  } catch (_) {
    return null;
  }
}

function subset(child, parent) {
  const parentSet = new Set(parent);
  return child.every((value) => parentSet.has(value));
}

module.exports = {
  ACTION_KEYS,
  AGENT_IDENTITY_RUNTIME_VERSION,
  AUTHORITY_KEYS,
  IDENTITY_CLAIM_KEYS,
  IDENTITY_RUNTIME_ERRORS,
  MAX_LIST_ITEMS,
  RECEIVER_BINDING_KEYS,
  RISK_ORDER,
  SHA256,
  SNAPSHOTS,
  allow,
  block,
  canonicalHash,
  exactObject,
  plain,
  readNow,
  snapshot,
  stringList,
  subset,
  text,
  validateIdentityRecord,
};
