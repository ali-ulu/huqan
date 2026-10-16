'use strict';

// #2223: resolving a claim to an identity in an authority snapshot, and
// validating the delegation chain behind it.

const { IDENTITY_CLAIM_KEYS, IDENTITY_RUNTIME_ERRORS, RISK_ORDER, SHA256, block, canonicalHash, exactObject, stringList, subset, text } = require('./agent-identity-runtime-shape');

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
    // A delegated claim must terminate at an authority-owned root. Checking
    // only adjacent child/parent pairs lets a chain whose first listed parent
    // points to an absent grandparent inherit scope without a verified root.
    if (!previous && record.parent_agent_id !== null) {
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

module.exports = {
  resolveIdentity,
  validateDelegationChain,
};
