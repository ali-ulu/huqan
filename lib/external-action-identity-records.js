'use strict';

// #2215: the identity block written into gate decisions and receipts
// (attested and unattested) and the finding record the identity check returns.

const { normalizedCardSignature } = require('./external-action-identity-signing');
const { AGENT_IDENTITY_CARD_SCHEMA_VERSION, CAPABILITY_WILDCARD, UNATTESTED_OWNER, computeIdentityCardHash, identityRefFor, text } = require('./external-action-identity-card');

/**
 * `signatureVerified` is a verdict this host reached about its own card, so a
 * reader who was not on this host has to take it on faith -- which is the
 * assurance a receipt exists to replace. `cardSignature` carries the detached
 * envelope that produced it, and every field the signature covers is already
 * in this block, so anyone holding the issuer's public key can re-derive the
 * verdict instead of trusting it (#1859).
 *
 * Present only when a signature was actually supplied: an absent field keeps
 * the canonical hash of every unsigned receipt exactly as it was.
 */
function identityBlock(core, { attested, sessionId, turnId, signatureVerified = false, cardSignature = null }) {
  return Object.freeze({
    schemaVersion: AGENT_IDENTITY_CARD_SCHEMA_VERSION,
    attested,
    signatureVerified,
    ...(cardSignature ? { cardSignature } : {}),
    identityRef: identityRefFor(core.workspaceId, core.agentId),
    identityHash: computeIdentityCardHash(core),
    agentId: core.agentId,
    agentName: core.agentName,
    agentVersion: core.agentVersion,
    ownerActorId: core.ownerActorId,
    onBehalfOf: core.onBehalfOf,
    workspaceId: core.workspaceId,
    capabilities: Object.freeze([...core.capabilities]),
    delegationChain: Object.freeze([...core.delegationChain]),
    issuedAt: core.issuedAt,
    expiresAt: core.expiresAt,
    // Present only on bound cards, so unscoped receipts keep their exact
    // canonical shape. The binding travels with the receipt for audit.
    ...(core.taskScope ? { taskScope: core.taskScope } : {}),
    sessionId,
    turnId,
  });
}

/**
 * Identity derived from the envelope alone, for callers that supply no card
 * (or whose card failed to parse). It is recorded with `attested: false` and an
 * `unattested` owner so a log reader can never confuse a name carried by the
 * transport with an identity someone actually granted.
 *
 * `attested: true` means a well-formed card was presented and bound to this
 * invocation — not that the action was allowed. Acceptance is the `identity`
 * gate finding and the receipt decision; an expired or out-of-scope card is
 * attested and blocked.
 */
function unattestedIdentity(envelope) {
  const agentId = text(envelope.agent?.instanceId) || text(envelope.agent?.name) || 'unknown-agent';
  const core = {
    agentId,
    agentName: text(envelope.agent?.name) || agentId,
    agentVersion: text(envelope.agent?.version),
    ownerActorId: UNATTESTED_OWNER,
    onBehalfOf: UNATTESTED_OWNER,
    workspaceId: text(envelope.workspaceId) || 'default',
    capabilities: [],
    delegationChain: [agentId],
    issuedAt: '',
    expiresAt: null,
  };
  return identityBlock(core, {
    attested: false,
    sessionId: text(envelope.session?.id),
    turnId: text(envelope.session?.turnId),
  });
}

function attestedIdentity(card, envelope, signatureVerified = false, sponsor = null) {
  const identity = identityBlock(card, {
    attested: true,
    signatureVerified,
    // Carried whether or not this host could verify it: a signature the host
    // holds no key for is still material a collector may hold the key for.
    // Normalized first, so a malformed envelope is dropped here rather than
    // travelling as if it were evidence.
    cardSignature: normalizedCardSignature(envelope.identityCardSignature),
    sessionId: text(envelope.session?.id),
    turnId: text(envelope.session?.turnId),
  });
  return sponsor ? Object.freeze({ ...identity, humanSponsor: sponsor }) : identity;
}

function grantsCapability(card, kind) {
  return card.capabilities.includes(CAPABILITY_WILDCARD) || card.capabilities.includes(kind);
}

function finding(decision, reason, identity, extra = {}) {
  return {
    gate: 'identity',
    decision,
    reason,
    identityRef: identity.identityRef,
    identityHash: identity.identityHash,
    attested: identity.attested,
    ...extra,
  };
}

module.exports = {
  attestedIdentity,
  finding,
  grantsCapability,
  unattestedIdentity,
};
