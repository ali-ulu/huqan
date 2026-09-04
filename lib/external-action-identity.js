'use strict';

/**
 * Faz C (#1769) — agent identity for the external action guard.
 *
 * The `huqan.external-action.v1` envelope already carries agentName /
 * agentVersion / sessionId / turnId, but those are free-form transport fields:
 * they say "something happened", not "identity X, holding authority Y, acting
 * for principal Z, did it". This module adds the missing capability card and
 * derives the identity block the guard writes into every gate decision and
 * every receipt.
 *
 * Scope boundary: this is the *simple* card, deliberately separate from
 * lib/agent-identity-runtime.js. That runtime (workspace authority snapshots,
 * signed delegation chains, revocation) stays behind the
 * docs/v5/v5-agent-identity-closeout-audit.md gate. Nothing here claims to be
 * V5 runtime identity enforcement.
 */

const crypto = require('node:crypto');
const { stableStringify } = require('./receipt/canonical-receipt');
const { isPlainObject } = require('./is-plain-object');
const {
  SIGNATURE_REASONS,
  normalizedCardSignature,
  verifyAgentIdentityCardSignature,
} = require('./external-action-identity-signing');
const { EXTERNAL_ACTION_KINDS } = require('./external-action-envelope');

const AGENT_IDENTITY_CARD_SCHEMA_VERSION = 'huqan.agent-identity-card.v1';
const CAPABILITY_WILDCARD = '*';
const UNATTESTED_OWNER = 'unattested';

const MAX_FIELD_BYTES = 256;
const MAX_CAPABILITIES = 32;
const MAX_DELEGATION_CHAIN = 16;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const IDENTITY_REASONS = Object.freeze({
  ATTESTED: 'agent_identity_attested',
  UNATTESTED: 'agent_identity_unattested',
  CARD_REQUIRED: 'agent_identity_card_required',
  CARD_INVALID: 'agent_identity_card_invalid',
  WORKSPACE_MISMATCH: 'agent_identity_workspace_mismatch',
  AGENT_MISMATCH: 'agent_identity_agent_mismatch',
  NOT_YET_VALID: 'agent_identity_card_not_yet_valid',
  EXPIRED: 'agent_identity_card_expired',
  CAPABILITY_NOT_GRANTED: 'agent_identity_capability_not_granted',
});

const CAPABILITY_VOCABULARY = Object.freeze([
  CAPABILITY_WILDCARD,
  ...Object.values(EXTERNAL_ACTION_KINDS),
]);

function text(value) {
  return typeof value === 'string' && value.trim().length > 0
    && Buffer.byteLength(value.trim(), 'utf8') <= MAX_FIELD_BYTES
    ? value.trim()
    : '';
}

function instant(value) {
  return typeof value === 'string' && INSTANT.test(value) && Number.isFinite(Date.parse(value))
    ? value
    : '';
}

function uniqueList(value, limit) {
  if (!Array.isArray(value) || value.length === 0 || value.length > limit) return null;
  const items = value.map(text);
  if (items.some(item => !item)) return null;
  return new Set(items).size === items.length ? items : null;
}

/**
 * Validate a supplied capability card. Returns `{ card, errors }` — `card` is
 * null whenever `errors` is non-empty, so a malformed card can never be
 * mistaken for an attested one.
 */
function normalizeAgentIdentityCard(input) {
  const errors = [];
  if (!isPlainObject(input)) return { card: null, errors: ['identity_card_not_an_object'] };

  const schemaVersion = text(input.schemaVersion);
  if (schemaVersion !== AGENT_IDENTITY_CARD_SCHEMA_VERSION) errors.push('identity_card_schema_version_invalid');

  const agentId = text(input.agentId);
  const agentName = text(input.agentName);
  const ownerActorId = text(input.ownerActorId);
  const workspaceId = text(input.workspaceId);
  const issuedAt = instant(input.issuedAt);
  if (!agentId) errors.push('identity_card_agent_id_missing');
  if (!agentName) errors.push('identity_card_agent_name_missing');
  if (!ownerActorId) errors.push('identity_card_owner_actor_id_missing');
  if (!workspaceId) errors.push('identity_card_workspace_id_missing');
  if (!issuedAt) errors.push('identity_card_issued_at_invalid');

  const capabilities = uniqueList(input.capabilities, MAX_CAPABILITIES);
  if (!capabilities) errors.push('identity_card_capabilities_invalid');
  else if (capabilities.some(capability => !CAPABILITY_VOCABULARY.includes(capability))) {
    errors.push('identity_card_capability_unknown');
  }

  const chainSupplied = input.delegationChain !== undefined && input.delegationChain !== null;
  const delegationChain = chainSupplied
    ? uniqueList(input.delegationChain, MAX_DELEGATION_CHAIN)
    : (agentId ? [agentId] : null);
  if (!delegationChain) errors.push('identity_card_delegation_chain_invalid');
  else if (agentId && delegationChain.at(-1) !== agentId) errors.push('identity_card_delegation_chain_not_terminal');

  const expiresSupplied = input.expiresAt !== undefined && input.expiresAt !== null;
  const expiresAt = expiresSupplied ? instant(input.expiresAt) : '';
  if (expiresSupplied && !expiresAt) errors.push('identity_card_expires_at_invalid');
  if (issuedAt && expiresAt && Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    errors.push('identity_card_expires_before_issued');
  }

  if (errors.length) return { card: null, errors };

  return {
    card: Object.freeze({
      schemaVersion: AGENT_IDENTITY_CARD_SCHEMA_VERSION,
      agentId,
      agentName,
      agentVersion: text(input.agentVersion),
      ownerActorId,
      onBehalfOf: text(input.onBehalfOf) || ownerActorId,
      workspaceId,
      capabilities: Object.freeze(capabilities),
      delegationChain: Object.freeze(delegationChain),
      issuedAt,
      expiresAt: expiresAt || null,
    }),
    errors: [],
  };
}

function identityRefFor(workspaceId, agentId) {
  return `agent:${workspaceId}:${agentId}`;
}

/**
 * The hash covers only the card's authority-bearing fields, so the same card
 * always yields the same identityHash regardless of which invocation carried
 * it. Session/turn are invocation context, not identity, and stay out.
 */
function computeIdentityCardHash(core) {
  return crypto.createHash('sha256').update(stableStringify(core), 'utf8').digest('hex');
}

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

function attestedIdentity(card, envelope, signatureVerified = false) {
  return identityBlock(card, {
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

/**
 * Resolve the identity for one external action and decide on it.
 *
 * Returns `{ identity, finding }`. `identity` is always present — an
 * unattested action still gets a persisted identity — so the caller can write
 * it to the receipt no matter which way the decision goes.
 *
 * A supplied card is enforced fail-closed. An absent card is `allow` by
 * default and only escalates when the deployment opts in via
 * `requireIdentityCard` (or `HUQAN_EXTERNAL_GUARD_REQUIRE_IDENTITY`), so
 * turning identity on is a deployment decision rather than a silent break of
 * every adapter that predates the card.
 */
function evaluateAgentIdentity(envelope, options = {}) {
  const supplied = envelope.identityCard;
  const requirement = identityRequirement(options);

  if (supplied === null || supplied === undefined) {
    const identity = unattestedIdentity(envelope);
    return {
      identity,
      finding: requirement === 'allow'
        ? finding('allow', IDENTITY_REASONS.UNATTESTED, identity)
        : finding(requirement, IDENTITY_REASONS.CARD_REQUIRED, identity),
    };
  }

  const { card, errors } = normalizeAgentIdentityCard(supplied);
  if (!card) {
    const identity = unattestedIdentity(envelope);
    return { identity, finding: finding('block', IDENTITY_REASONS.CARD_INVALID, identity, { flags: errors }) };
  }

  const signatureVerified = verifyCardSignature(card, envelope, options);
  const signatureRequirementValue = signatureRequirement(options);
  if (signatureRequirementValue !== 'allow' && !signatureVerified) {
    const identity = attestedIdentity(card, envelope, false);
    const reason = envelope.identityCardSignature === undefined || envelope.identityCardSignature === null
      ? SIGNATURE_REASONS.MISSING
      : SIGNATURE_REASONS.INVALID;
    return { identity, finding: finding(signatureRequirementValue, reason, identity) };
  }

  const identity = attestedIdentity(card, envelope, signatureVerified);
  if (card.workspaceId !== (text(envelope.workspaceId) || 'default')) {
    return {
      identity,
      finding: finding('block', IDENTITY_REASONS.WORKSPACE_MISMATCH, identity, {
        expectedWorkspaceId: envelope.workspaceId,
      }),
    };
  }
  if (card.agentName !== text(envelope.agent?.name)) {
    return { identity, finding: finding('block', IDENTITY_REASONS.AGENT_MISMATCH, identity) };
  }

  const now = readNow(options);
  if (Date.parse(card.issuedAt) > now) {
    return { identity, finding: finding('block', IDENTITY_REASONS.NOT_YET_VALID, identity) };
  }
  if (card.expiresAt && Date.parse(card.expiresAt) <= now) {
    return { identity, finding: finding('block', IDENTITY_REASONS.EXPIRED, identity) };
  }
  if (!grantsCapability(card, envelope.kind)) {
    return {
      identity,
      finding: finding('block', IDENTITY_REASONS.CAPABILITY_NOT_GRANTED, identity, { capability: envelope.kind }),
    };
  }
  return { identity, finding: finding('allow', IDENTITY_REASONS.ATTESTED, identity) };
}

function identityRequirement(options) {
  const supplied = options.requireIdentityCard;
  if (supplied === true) return 'block';
  if (supplied === 'review' || supplied === 'block') return supplied;
  if (supplied === false) return 'allow';
  const environment = options.environment || process.env;
  const flag = String(environment.HUQAN_EXTERNAL_GUARD_REQUIRE_IDENTITY || '').trim().toLowerCase();
  if (flag === 'review') return 'review';
  if (['1', 'true', 'block', 'require'].includes(flag)) return 'block';
  return 'allow';
}

/**
 * Signature enforcement is a separate, strictly opt-in deployment decision:
 * without `trustedPublicKeys` nothing can verify, so the requirement must stay
 * off by default or every existing adapter would break. Fail-closed once on:
 * a required signature that is missing or fails verification blocks the call.
 */
function signatureRequirement(options) {
  const supplied = options.requireSignedIdentityCard;
  if (supplied === true) return 'block';
  if (supplied === 'review' || supplied === 'block') return supplied;
  if (supplied === false) return 'allow';
  const environment = options.environment || process.env;
  const flag = String(environment.HUQAN_EXTERNAL_GUARD_REQUIRE_SIGNED_IDENTITY || '').trim().toLowerCase();
  if (flag === 'review') return 'review';
  if (['1', 'true', 'block', 'require'].includes(flag)) return 'block';
  return 'allow';
}

function verifyCardSignature(card, envelope, options) {
  const keys = Array.isArray(options.trustedPublicKeys)
    ? options.trustedPublicKeys.filter((pem) => typeof pem === 'string' && pem.length > 0)
    : [];
  if (!keys.length) return false;
  const signature = envelope.identityCardSignature;
  if (signature === undefined || signature === null) return false;
  return keys.some((pem) => verifyAgentIdentityCardSignature(card, signature, pem));
}

function readNow(options) {
  if (typeof options.now === 'function') {
    const value = Date.parse(options.now());
    if (Number.isFinite(value)) return value;
  }
  return Date.now();
}

module.exports = {
  AGENT_IDENTITY_CARD_SCHEMA_VERSION,
  CAPABILITY_VOCABULARY,
  CAPABILITY_WILDCARD,
  IDENTITY_REASONS,
  UNATTESTED_OWNER,
  computeIdentityCardHash,
  evaluateAgentIdentity,
  identityRefFor,
  normalizeAgentIdentityCard,
  unattestedIdentity,
};
