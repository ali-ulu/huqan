'use strict';

/**
 * The issuer's seal over a receipt it produced.
 *
 * A receipt already proves its own contents have not changed: `contentHash`
 * binds it to exact bytes and `prior_receipt` chains it to what came before.
 * What no field said until now is *who produced it*. A reader holding a
 * receipt could not tell a HUQAN-issued one from a hand-written file with the
 * same shape.
 *
 * ## What the seal claims, exactly
 *
 *   "This receipt was issued by the holder of this key, at this time, and
 *    covers exactly these bytes."
 *
 * That is the whole claim. The seal deliberately does NOT say the content is
 * true, that the decision was correct, or that anything was "verified" or
 * "certified" -- HUQAN cannot know any of that, and a badge implying it would
 * be decoration that the first serious audit would strip off. The field is
 * `issuedBy`, and there is no `verifiedBy`. A test asserts no field in the
 * payload is named with a truth word.
 *
 * ## Why it cannot be copied
 *
 * Three properties, each covered by the signature:
 *
 * - `receiptHash` binds the seal to one specific receipt's bytes, so a seal
 *   lifted onto another receipt fails immediately;
 * - `keyId` is *derived* from the public key, not declared. Verification
 *   recomputes the fingerprint from the key it resolved and requires a match,
 *   so an instance cannot claim a fingerprint it does not hold the key for;
 * - the signature itself can only be produced by that private key.
 *
 * Editing any of them breaks verification. Writing the fields by hand without
 * the key produces a seal that fails on the signature.
 *
 * ## Honest boundary
 *
 * The issuing key lives on the operator's own host. This seal therefore proves
 * origin and integrity, not operator honesty: someone holding that key can
 * issue a receipt saying whatever they like and seal it validly. That is the
 * second rung, not the third. Third-party evidence is ./collector-seal.js,
 * which is signed with a key the issuing host does not have -- and only when
 * the collector runs somewhere the operator does not administer.
 *
 * This module is a pure builder/verifier: no I/O, no key loading, no policy.
 */

const crypto = require('node:crypto');
const { stableStringify } = require('./canonical-receipt');

const ISSUER_SEAL_VERSION = 'huqan.issuer-seal.v1';
const SIGNATURE_ALGORITHM = 'ed25519';
const ISSUER_PRODUCT = 'huqan';
const FINGERPRINT_HEX_LENGTH = 32;
const ED25519_SIGNATURE_BYTES = 64;

/**
 * A stable, verifiable name for an issuing instance: the truncated SHA-256 of
 * the key's SPKI DER encoding. Derived rather than declared, so the identity
 * cannot be claimed by an instance that does not hold the key. Carries no host
 * name, address, or path, so naming the issuer leaks nothing about where it
 * runs. Returns '' for anything that is not an ed25519 public key.
 */
function issuerKeyFingerprint(publicKeyPem) {
  if (typeof publicKeyPem !== 'string' || !publicKeyPem) return '';
  try {
    const key = crypto.createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== SIGNATURE_ALGORITHM) return '';
    const der = key.export({ type: 'spki', format: 'der' });
    const digest = crypto.createHash('sha256').update(der).digest('hex');
    return `${SIGNATURE_ALGORITHM}:${digest.slice(0, FINGERPRINT_HEX_LENGTH)}`;
  } catch (_) {
    return '';
  }
}

/**
 * The statement being signed. `receiptHash` is the canonical receipt hash from
 * ./canonical-receipt.js, so the seal attests to a specific set of bytes and
 * not merely to a receipt id that could be reused.
 */
function canonicalIssuerSealPayload({ receiptHash, receiptId, workspaceId, issuedAt, productVersion } = {}) {
  return {
    schemaVersion: ISSUER_SEAL_VERSION,
    issuedBy: ISSUER_PRODUCT,
    productVersion: String(productVersion || ''),
    receiptHash: String(receiptHash || ''),
    receiptId: String(receiptId || ''),
    workspaceId: String(workspaceId || ''),
    issuedAt: String(issuedAt || ''),
  };
}

function sealHash(payload) {
  return `sha256:${crypto.createHash('sha256').update(stableStringify(payload), 'utf8').digest('hex')}`;
}

/**
 * Seal a receipt. Returns null on anything malformed, so a caller configured to
 * seal fails loudly rather than storing an unsealed receipt that looks sealed.
 */
function signIssuerSeal(input, { privateKeyPem } = {}) {
  if (typeof privateKeyPem !== 'string' || !privateKeyPem) return null;
  const payload = canonicalIssuerSealPayload(input);
  if (!payload.receiptHash || !payload.receiptId || !payload.issuedAt) return null;
  try {
    const key = crypto.createPrivateKey(privateKeyPem);
    if (key.asymmetricKeyType !== SIGNATURE_ALGORITHM) return null;
    const publicKeyPem = crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString();
    const keyId = issuerKeyFingerprint(publicKeyPem);
    if (!keyId) return null;
    return Object.freeze({
      ...payload,
      keyId,
      algorithm: SIGNATURE_ALGORITHM,
      sealHash: sealHash(payload),
      signature: crypto.sign(null, Buffer.from(stableStringify(payload), 'utf8'), key).toString('base64'),
    });
  } catch (_) {
    return null;
  }
}

/**
 * True only when this key made this seal over this statement. Reports a reason
 * rather than a bare false: "the fingerprint on the seal is not this key's" and
 * "the signature does not check out" are different failures, and an auditor
 * needs to tell them apart.
 */
function verifyIssuerSeal(seal, publicKeyPem) {
  if (!seal || typeof seal !== 'object') return { ok: false, reason: 'malformed_seal' };
  if (seal.schemaVersion !== ISSUER_SEAL_VERSION) return { ok: false, reason: 'unsupported_schema' };
  if (seal.algorithm !== SIGNATURE_ALGORITHM) return { ok: false, reason: 'unsupported_algorithm' };
  if (typeof seal.signature !== 'string' || !seal.signature) return { ok: false, reason: 'missing_signature' };
  if (typeof publicKeyPem !== 'string' || !publicKeyPem) return { ok: false, reason: 'no_public_key' };

  const fingerprint = issuerKeyFingerprint(publicKeyPem);
  if (!fingerprint) return { ok: false, reason: 'unsupported_public_key' };
  if (seal.keyId !== fingerprint) return { ok: false, reason: 'key_fingerprint_mismatch' };

  // Recompute rather than trust the stored hash: `sealHash` is a convenience
  // for indexing, never an input to the decision.
  const payload = canonicalIssuerSealPayload(seal);
  if (sealHash(payload) !== seal.sealHash) return { ok: false, reason: 'seal_hash_mismatch' };

  try {
    const key = crypto.createPublicKey(publicKeyPem);
    const signature = Buffer.from(seal.signature, 'base64');
    if (signature.length !== ED25519_SIGNATURE_BYTES) return { ok: false, reason: 'malformed_signature' };
    const verified = crypto.verify(null, Buffer.from(stableStringify(payload), 'utf8'), key, signature);
    return verified ? { ok: true, reason: '', keyId: seal.keyId } : { ok: false, reason: 'signature_invalid' };
  } catch (_) {
    return { ok: false, reason: 'signature_invalid' };
  }
}

module.exports = Object.freeze({
  ISSUER_SEAL_VERSION,
  ISSUER_PRODUCT,
  issuerKeyFingerprint,
  canonicalIssuerSealPayload,
  sealHash,
  signIssuerSeal,
  verifyIssuerSeal,
});
