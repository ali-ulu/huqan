'use strict';

/**
 * Cryptographic signatures for the external-action guard capability card.
 *
 * The simple card (lib/external-action-identity.js, #1769) is an unsigned
 * statement of authority. This module adds the missing link #1781's collector
 * depends on: an ed25519 signature over the canonical card, so a receipt
 * gathered from another machine can be bound to a verified issuer instead of
 * trusting whichever process handed the guard its card.
 *
 * Scope boundary: key *distribution* is a deployment concern — the caller
 * supplies trusted public keys per decision. This module never generates
 * trust, only verifies it, and fails closed on every malformed input.
 */

const crypto = require('node:crypto');
const { stableStringify } = require('./receipt/canonical-receipt');

const IDENTITY_CARD_SIGNATURE_VERSION = 'huqan.agent-identity-card-signature.v1';
const SIGNATURE_ALGORITHM = 'ed25519';

const SIGNATURE_REASONS = Object.freeze({
  VALID: 'agent_identity_card_signature_valid',
  INVALID: 'agent_identity_card_signature_invalid',
  MISSING: 'agent_identity_card_signature_missing',
  MALFORMED: 'agent_identity_card_signature_malformed',
});

function canonicalCardBytes(card) {
  return Buffer.from(stableStringify(card), 'utf8');
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Generate an ed25519 key pair for identity card signing. Returns PEM strings;
 * private key handling is entirely the deployment's responsibility.
 */
function generateIdentityCardKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return Object.freeze({
    algorithm: SIGNATURE_ALGORITHM,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  });
}

/**
 * Sign a validated capability card. The signature covers the canonical
 * serialization of the card, so any field mutation (including key reordering)
 * invalidates it. Returns a detached signature envelope meant to travel next
 * to the card (e.g. `identityCardSignature` on the envelope).
 */
function signAgentIdentityCard(card, privateKeyPem) {
  if (card === null || typeof card !== 'object' || Array.isArray(card)) return null;
  if (!isNonEmptyString(privateKeyPem)) return null;
  let key;
  try {
    key = crypto.createPrivateKey(privateKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') return null;
  } catch (_) {
    return null;
  }
  try {
    const signature = crypto.sign(null, canonicalCardBytes(card), key);
    return Object.freeze({
      schemaVersion: IDENTITY_CARD_SIGNATURE_VERSION,
      algorithm: SIGNATURE_ALGORITHM,
      signature: signature.toString('base64'),
    });
  } catch (_) {
    return null;
  }
}

function parseSignatureEnvelope(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  // Object.keys rather than Reflect.ownKeys: ownKeys returns symbols too, and
  // a symbol among exactly three keys made `.sort()` throw
  // "Cannot convert a Symbol value to a string" -- an exception where this
  // module promises a false. Symbols cannot survive the envelope's jsonClone,
  // so dropping them here costs nothing and keeps every malformed input a
  // verification failure rather than a crash in the caller.
  const keys = Object.keys(input).sort();
  const expected = ['algorithm', 'schemaVersion', 'signature'];
  if (keys.length !== expected.length || keys.join('\u0000') !== expected.join('\u0000')) return null;
  if (input.schemaVersion !== IDENTITY_CARD_SIGNATURE_VERSION) return null;
  if (input.algorithm !== SIGNATURE_ALGORITHM) return null;
  if (!isNonEmptyString(input.signature) || input.signature.length > 4096) return null;
  return input.signature;
}

function toPublicKey(pem) {
  try {
    const key = crypto.createPublicKey(pem);
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch (_) {
    return null;
  }
}

/**
 * Verify a detached signature envelope against a capability card and one
 * trusted public key. Never throws; any malformed input is a verification
 * failure, not an exception.
 */
function verifyAgentIdentityCardSignature(card, signatureEnvelope, publicKeyPem) {
  if (card === null || typeof card !== 'object' || Array.isArray(card)) return false;
  const signature = parseSignatureEnvelope(signatureEnvelope);
  if (!signature) return false;
  const key = toPublicKey(publicKeyPem);
  if (!key) return false;
  let raw;
  try {
    raw = Buffer.from(signature, 'base64');
  } catch (_) {
    return false;
  }
  // ed25519 signatures are exactly 64 bytes; reject everything else before
  // feeding it to the verifier.
  if (raw.length !== 64) return false;
  try {
    return crypto.verify(null, canonicalCardBytes(card), key, raw);
  } catch (_) {
    return false;
  }
}

/**
 * The envelope, reduced to exactly what a receipt should carry, or null.
 *
 * Reusing the same parser the verifier uses means a receipt can never carry a
 * shape that would fail verification anyway: a malformed envelope is dropped
 * at the point it would have become evidence, not at the point someone tries
 * to rely on it.
 */
function normalizedCardSignature(input) {
  const signature = parseSignatureEnvelope(input);
  if (!signature) return null;
  return Object.freeze({
    schemaVersion: IDENTITY_CARD_SIGNATURE_VERSION,
    algorithm: SIGNATURE_ALGORITHM,
    signature,
  });
}

/**
 * Rebuild the signed card from a persisted `metadata.identity` block.
 *
 * The block already carries every field of the normalized card, so nothing has
 * to be duplicated into the receipt for this to work -- and because the
 * signature covers the canonical serialization of exactly these fields, a
 * block that was altered in the trail cannot be rebuilt into a card that still
 * verifies. Returns null for an unattested identity, which has no card at all.
 */
function agentIdentityCardFromReceiptIdentity(identity) {
  if (identity === null || typeof identity !== 'object' || Array.isArray(identity)) return null;
  if (identity.attested !== true) return null;
  return {
    schemaVersion: identity.schemaVersion,
    agentId: identity.agentId,
    agentName: identity.agentName,
    agentVersion: identity.agentVersion,
    ownerActorId: identity.ownerActorId,
    onBehalfOf: identity.onBehalfOf,
    workspaceId: identity.workspaceId,
    capabilities: Array.isArray(identity.capabilities) ? [...identity.capabilities] : [],
    delegationChain: Array.isArray(identity.delegationChain) ? [...identity.delegationChain] : [],
    issuedAt: identity.issuedAt,
    expiresAt: identity.expiresAt === undefined ? null : identity.expiresAt,
  };
}

/**
 * Re-derive the identity verdict a receipt asserts, against keys the reader
 * trusts. `signatureVerified` on the receipt is the sending host's claim; this
 * is the reader's own answer, and the two are allowed to disagree -- that
 * disagreement is exactly what a collector needs to be able to see.
 */
function verifyReceiptIdentityCardSignature(identity, publicKeyPems = []) {
  const card = agentIdentityCardFromReceiptIdentity(identity);
  if (!card || !identity.cardSignature) return false;
  const keys = (Array.isArray(publicKeyPems) ? publicKeyPems : [publicKeyPems])
    .filter(pem => typeof pem === 'string' && pem.length > 0);
  return keys.some(pem => verifyAgentIdentityCardSignature(card, identity.cardSignature, pem));
}

module.exports = Object.freeze({
  IDENTITY_CARD_SIGNATURE_VERSION,
  SIGNATURE_ALGORITHM,
  SIGNATURE_REASONS,
  agentIdentityCardFromReceiptIdentity,
  generateIdentityCardKeyPair,
  normalizedCardSignature,
  signAgentIdentityCard,
  verifyAgentIdentityCardSignature,
  verifyReceiptIdentityCardSignature,
});
