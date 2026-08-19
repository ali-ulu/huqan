'use strict';

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

function snapshotAgentIdentityAuthority(options = {}) {
  if (!plain(options) || !exactObject(options, AUTHORITY_KEYS)) {
    throw new TypeError(IDENTITY_RUNTIME_ERRORS.AUTHORITY_INVALID);
  }
  if (!text(options.workspaceId) || !Array.isArray(options.identities)
      || options.identities.length === 0 || options.identities.length > MAX_LIST_ITEMS
      || typeof options.clock !== 'function') {
    throw new TypeError(IDENTITY_RUNTIME_ERRORS.AUTHORITY_INVALID);
  }

  const byRef = Object.create(null);
  const byId = Object.create(null);
  for (const entry of options.identities) {
    if (!exactObject(entry, ['ref', 'record']) || !text(entry.ref)
        || Object.hasOwn(byRef, entry.ref) || !validateIdentityRecord(entry.record)) {
      throw new TypeError(IDENTITY_RUNTIME_ERRORS.AUTHORITY_INVALID);
    }
    if (entry.record.workspace_id !== options.workspaceId
        || Object.hasOwn(byId, entry.record.agent_id)) {
      throw new TypeError(IDENTITY_RUNTIME_ERRORS.AUTHORITY_INVALID);
    }
    const record = snapshot({ ...entry.record });
    byRef[entry.ref] = Object.freeze({ ref: entry.ref, record });
    byId[record.agent_id] = byRef[entry.ref];
  }

  const authority = snapshot({
    version: AGENT_IDENTITY_RUNTIME_VERSION,
    workspaceId: options.workspaceId,
    identitiesByRef: byRef,
    identitiesById: byId,
    clock: options.clock,
  });
  SNAPSHOTS.add(authority);
  return authority;
}

function resolveIdentity(authority, claim, now) {
  if (!exactObject(claim, IDENTITY_CLAIM_KEYS)
      || !text(claim.agentId) || !text(claim.identityRef) || !SHA256.test(claim.identityHash)
      || !text(claim.workspaceId) || !stringList(claim.delegationChain)) {
    return block(IDENTITY_RUNTIME_ERRORS.CLAIM_INVALID);
  }
  if (claim.workspaceId !== authority.workspaceId) {
    return block(IDENTITY_RUNTIME_ERRORS.WORKSPACE_MISMATCH, {
      expectedWorkspaceId: authority.workspaceId,
      receivedWorkspaceId: claim.workspaceId,
    });
  }
  const entry = authority.identitiesByRef[claim.identityRef];
  if (!entry || entry.record.agent_id !== claim.agentId) {
    return block(IDENTITY_RUNTIME_ERRORS.IDENTITY_UNKNOWN);
  }
  const identity = entry.record;
  let identityHash;
  try { identityHash = canonicalHash(identity); } catch (_) { return block(IDENTITY_RUNTIME_ERRORS.IDENTITY_HASH_INVALID); }
  if (identityHash !== claim.identityHash) {
    return block(IDENTITY_RUNTIME_ERRORS.IDENTITY_HASH_INVALID);
  }
  if (Date.parse(identity.issued_at) > now) return block(IDENTITY_RUNTIME_ERRORS.NOT_YET_VALID);
  if (Date.parse(identity.expires_at) <= now) return block(IDENTITY_RUNTIME_ERRORS.EXPIRED);
  if (identity.revoked_at !== null || identity.revocation_reason !== null) {
    return block(IDENTITY_RUNTIME_ERRORS.REVOKED);
  }
  if (!['valid', 'registered'].includes(identity.verification_status)
      || identity.expected_status !== 'valid') {
    return block(IDENTITY_RUNTIME_ERRORS.VERIFICATION_INVALID);
  }
  if (identity.parent_agent_id === null) {
    if (JSON.stringify(claim.delegationChain) !== JSON.stringify([identity.agent_id])) {
      return block(IDENTITY_RUNTIME_ERRORS.DELEGATION_CHAIN_INVALID);
    }
  } else if (JSON.stringify(claim.delegationChain) !== JSON.stringify(identity.delegation_chain)
      || claim.delegationChain.at(-1) !== identity.agent_id) {
    return block(IDENTITY_RUNTIME_ERRORS.DELEGATION_CHAIN_INVALID);
  }
  return { identity, entry };
}

function validateDelegationChain(authority, identity, chain, now) {
  if (identity.parent_agent_id === null) return null;
  let previous = null;
  for (const agentId of chain) {
    const entry = authority.identitiesById[agentId];
    if (!entry) return block(IDENTITY_RUNTIME_ERRORS.DELEGATION_CHAIN_INVALID);
    const record = entry.record;
    if (record.workspace_id !== authority.workspaceId
        || Date.parse(record.issued_at) > now || Date.parse(record.expires_at) <= now
        || record.revoked_at !== null || record.revocation_reason !== null) {
      return block(IDENTITY_RUNTIME_ERRORS.DELEGATION_CHAIN_INVALID);
    }
    if (previous) {
      if (record.parent_agent_id !== previous.agent_id
          || !subset(record.delegation_scope, previous.delegation_scope)
          || !subset(record.allowed_tools, previous.allowed_tools)
          || !subset(record.allowed_connectors, previous.allowed_connectors)
          || RISK_ORDER[record.risk_tier] > RISK_ORDER[previous.risk_tier]
          || Date.parse(record.expires_at) > Date.parse(previous.expires_at)) {
        return block(IDENTITY_RUNTIME_ERRORS.DELEGATION_SCOPE_EXCEEDED);
      }
    }
    previous = record;
  }
  if (!previous || previous.agent_id !== identity.agent_id) {
    return block(IDENTITY_RUNTIME_ERRORS.DELEGATION_CHAIN_INVALID);
  }
  return null;
}

function evaluateAgentIdentity({ authority, claim, action } = {}) {
  if (!SNAPSHOTS.has(authority)) return block(IDENTITY_RUNTIME_ERRORS.AUTHORITY_REQUIRED);
  try {
    if (!exactObject(action, ACTION_KEYS) || !text(action.capability) || !text(action.target)
        || !Object.hasOwn(RISK_ORDER, action.riskTier)
        || (action.tool !== null && !text(action.tool))
        || (action.connector !== null && !text(action.connector))) {
      return block(IDENTITY_RUNTIME_ERRORS.TARGET_INVALID);
    }
    const now = readNow(authority.clock);
    if (now === null) return block(IDENTITY_RUNTIME_ERRORS.EVALUATION_FAILED);
    const resolved = resolveIdentity(authority, claim, now);
    if (resolved.decision === 'block') return resolved;
    const { identity } = resolved;
    const chainFailure = validateDelegationChain(authority, identity, claim.delegationChain, now);
    if (chainFailure) return chainFailure;
    if (!identity.delegation_scope.includes(action.capability)) {
      return block(IDENTITY_RUNTIME_ERRORS.CAPABILITY_NOT_ALLOWED, { capability: action.capability });
    }
    if (action.tool !== null && !identity.allowed_tools.includes(action.tool)) {
      return block(IDENTITY_RUNTIME_ERRORS.TOOL_NOT_ALLOWED, { tool: action.tool });
    }
    if (action.connector !== null && !identity.allowed_connectors.includes(action.connector)) {
      return block(IDENTITY_RUNTIME_ERRORS.CONNECTOR_NOT_ALLOWED, { connector: action.connector });
    }
    if (RISK_ORDER[action.riskTier] > RISK_ORDER[identity.risk_tier]) {
      return block(IDENTITY_RUNTIME_ERRORS.RISK_TIER_EXCEEDED, {
        requested: action.riskTier,
        maximum: identity.risk_tier,
      });
    }
    return allow(identity, claim, action, new Date(now).toISOString());
  } catch (_) {
    return block(IDENTITY_RUNTIME_ERRORS.EVALUATION_FAILED);
  }
}

module.exports = Object.freeze({
  AGENT_IDENTITY_RUNTIME_VERSION,
  IDENTITY_RUNTIME_ERRORS,
  evaluateAgentIdentity,
  snapshotAgentIdentityAuthority,
  validateIdentityRecord,
});
