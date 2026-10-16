'use strict';

// Agent identity runtime: authority snapshots, receiver-owned claims and the
// identity decision for an action. Shapes and results live in
// agent-identity-runtime-shape.js, resolution in agent-identity-runtime-resolve.js (#2223).

const { resolveIdentity, validateDelegationChain } = require('./agent-identity-runtime-resolve');
const { ACTION_KEYS, AGENT_IDENTITY_RUNTIME_VERSION, AUTHORITY_KEYS, IDENTITY_RUNTIME_ERRORS, MAX_LIST_ITEMS, RECEIVER_BINDING_KEYS, RISK_ORDER, SNAPSHOTS, allow, block, canonicalHash, exactObject, plain, readNow, snapshot, text, validateIdentityRecord } = require('./agent-identity-runtime-shape');

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


function composeReceiverOwnedIdentityClaim({ authority, identityRef, receiver } = {}) {
  if (!SNAPSHOTS.has(authority) || !text(identityRef) || !exactObject(receiver, RECEIVER_BINDING_KEYS)
      || !text(receiver.subject) || !text(receiver.kind) || !text(receiver.workspaceId)) {
    return block(IDENTITY_RUNTIME_ERRORS.AUTHORITY_INVALID);
  }
  if (receiver.workspaceId !== authority.workspaceId) {
    return block(IDENTITY_RUNTIME_ERRORS.WORKSPACE_MISMATCH, {
      expectedWorkspaceId: authority.workspaceId,
      receivedWorkspaceId: receiver.workspaceId,
    });
  }
  const entry = authority.identitiesByRef[identityRef];
  if (!entry) return block(IDENTITY_RUNTIME_ERRORS.IDENTITY_UNKNOWN);
  if (entry.record.owner_actor_id !== receiver.subject) {
    return block(IDENTITY_RUNTIME_ERRORS.IDENTITY_UNKNOWN, {
      receiverSubject: receiver.subject,
    });
  }
  let identityHash;
  try { identityHash = canonicalHash(entry.record); } catch (_) {
    return block(IDENTITY_RUNTIME_ERRORS.IDENTITY_HASH_INVALID);
  }
  const delegationChain = entry.record.parent_agent_id === null
    ? [entry.record.agent_id]
    : [...entry.record.delegation_chain];
  const claim = Object.freeze({
    agentId: entry.record.agent_id,
    identityRef,
    identityHash,
    workspaceId: authority.workspaceId,
    delegationChain: Object.freeze(delegationChain),
  });
  return Object.freeze({
    version: AGENT_IDENTITY_RUNTIME_VERSION,
    decision: 'allow',
    allowed: true,
    reason: 'ok',
    claim,
    receiver: Object.freeze({ subject: receiver.subject, kind: receiver.kind, workspaceId: receiver.workspaceId }),
  });
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
  composeReceiverOwnedIdentityClaim,
  evaluateAgentIdentity,
  snapshotAgentIdentityAuthority,
  validateIdentityRecord,
});
