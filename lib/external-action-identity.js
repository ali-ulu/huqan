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

// Split (#2215): the card lives in external-action-identity-card.js, the
// identity block and findings in external-action-identity-records.js; this
// file decides.

const { productionIdentityRequired, verifyHumanSponsor } = require('./human-sponsor-authority');
const { SIGNATURE_REASONS, verifyAgentIdentityCardSignature } = require('./external-action-identity-signing');
const { emergencyStopLedger } = require('./emergency-stop');
const { AGENT_IDENTITY_CARD_SCHEMA_VERSION, CAPABILITY_VOCABULARY, CAPABILITY_WILDCARD, IDENTITY_REASONS, UNATTESTED_OWNER, computeIdentityCardHash, identityRefFor, normalizeAgentIdentityCard, text } = require('./external-action-identity-card');
const { attestedIdentity, finding, grantsCapability, unattestedIdentity } = require('./external-action-identity-records');

/**
 * Resolve the identity for one external action and decide on it.
 *
 * Returns `{ identity, finding }`. `identity` is always present — an
 * unattested action still gets a persisted identity — so the caller can write
 * it to the receipt no matter which way the decision goes.
 *
 * A supplied card is enforced fail-closed. An absent card is `block` by
 * default (#2505 C owner decision): identity is required unless the
 * deployment explicitly opts out with `requireIdentityCard: false` (or the
 * env flag set to allow), so production always requires a signed card bound
 * to a registered human sponsor.
 */
function evaluateAgentIdentity(envelope, options = {}) {
  const result = evaluateAgentIdentityCard(envelope, options);
  // #2505 F: an emergency stop outranks every card. The ledger comes from the
  // deployment's options or the state root, never from the envelope.
  const stop = emergencyStopLedger(options).check({ workspaceId: envelope.workspaceId, agentId: envelope.agent?.name });
  if (!stop.stopped) return result;
  return {
    identity: result.identity,
    finding: finding('block', stop.reason, result.identity, { stopScope: stop.scope }),
  };
}

function evaluateAgentIdentityCard(envelope, options = {}) {
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

  const production = productionIdentityRequired(options);
  const sponsor = production ? verifyHumanSponsor(card, envelope, options) : null;
  const signatureVerified = production ? sponsor !== null : verifyCardSignature(card, envelope, options);
  const signatureRequirementValue = signatureRequirement(options);
  if (signatureRequirementValue !== 'allow' && !signatureVerified) {
    const identity = attestedIdentity(card, envelope, false);
    const reason = envelope.identityCardSignature === undefined || envelope.identityCardSignature === null
      ? SIGNATURE_REASONS.MISSING
      : SIGNATURE_REASONS.INVALID;
    return { identity, finding: finding(signatureRequirementValue, reason, identity) };
  }

  const identity = attestedIdentity(card, envelope, signatureVerified, sponsor);
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
  // #2505 C: a bound card grants only inside its scope. Unscoped cards fall
  // through exactly as before. `runId` binds to the envelope session (the
  // run); `taskId` binds to a caller-supplied task the envelope cannot carry
  // on its own. A bound grant with no matching scope fails closed.
  const scopeMismatch = taskScopeMismatch(card, envelope, options);
  if (scopeMismatch) {
    return { identity, finding: finding('block', IDENTITY_REASONS.TASK_SCOPE_MISMATCH, identity, scopeMismatch) };
  }
  return { identity, finding: finding('allow', IDENTITY_REASONS.ATTESTED, identity) };
}

function taskScopeMismatch(card, envelope, options = {}) {
  const scope = card.taskScope;
  if (!scope) return null;
  if (scope.runId && scope.runId !== text(envelope.session?.id)) {
    return { taskScope: scope, expectedRunId: envelope.session?.id };
  }
  if (scope.taskId) {
    const current = text(options.taskId);
    if (!current || current !== scope.taskId) {
      return { taskScope: scope, expectedTaskId: options.taskId };
    }
  }
  return null;
}

// #2505 C owner decision: block unless the deployment explicitly opts out.
function identityFlag(options, name) {
  const flag = String((options.environment || process.env)[name] || '').trim().toLowerCase();
  if (flag === 'review') return 'review';
  return ['0', 'false', 'allow'].includes(flag) ? 'allow' : 'block';
}

function identityRequirement(options) {
  if (productionIdentityRequired(options)) return 'block';
  const supplied = options.requireIdentityCard;
  if (supplied === true) return 'block';
  if (supplied === 'review' || supplied === 'block') return supplied;
  if (supplied === false) return 'allow';
  return identityFlag(options, 'HUQAN_EXTERNAL_GUARD_REQUIRE_IDENTITY');
}

/**
 * Production requires a signature verified against the sponsoring human's
 * registered keys. Outside production the legacy opt-in requirement remains.
 * Missing or invalid required signatures block the call.
 */
function signatureRequirement(options) {
  if (productionIdentityRequired(options)) return 'block';
  const supplied = options.requireSignedIdentityCard;
  if (supplied === true) return 'block';
  if (supplied === 'review' || supplied === 'block') return supplied;
  if (supplied === false) return 'allow';
  return identityFlag(options, 'HUQAN_EXTERNAL_GUARD_REQUIRE_SIGNED_IDENTITY');
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
