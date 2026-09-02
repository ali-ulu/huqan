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
  const keys = Reflect.ownKeys(input).sort();
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

module.exports = Object.freeze({
  IDENTITY_CARD_SIGNATURE_VERSION,
  SIGNATURE_ALGORITHM,
  SIGNATURE_REASONS,
  generateIdentityCardKeyPair,
  signAgentIdentityCard,
  verifyAgentIdentityCardSignature,
});
