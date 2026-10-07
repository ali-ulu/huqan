'use strict';

/**
 * A versioned, signed policy object (#3490, R35).
 *
 * K0 (#3470) gives policy objects an id, a semver version, a scope and a
 * receipt, and refuses learned authority -- but nothing binds those fields to
 * a key. A policy file copied between workspaces, or an old version
 * re-presented as current, passes every K0 check. This seal closes that:
 * the signature covers the policy's identity (knowledgeId, version,
 * workspace), a digest of its exact content bytes, the signature time, and
 * the transparency evidence the deployment witnessed.
 *
 * Transparency (#3490 "tlog zorunluluğu"): a sealed policy names the
 * transparency log that witnessed it ({ log, leafIndex, integratedAt }).
 * Verification requires that evidence by default and fails closed without
 * it; `allowMissingTransparency` is an explicit, caller-owned escape hatch
 * for deployments with no log yet -- never a silent default.
 *
 * issuedAt binding (#3490 "imza zamanını kanıta bağla"): verification takes
 * the evidence time the seal is presented with. A seal from the future, or
 * one post-dating that evidence, is refused.
 *
 * Pure builder/verifier like issuer-seal.js: no I/O, no key loading.
 */

const crypto = require('node:crypto');
const { stableStringify, sha256Hex } = require('./canonical-receipt');
const { issuerKeyFingerprint } = require('./issuer-seal');

const POLICY_SEAL_VERSION = 'huqan.policy-seal.v1';
const SIGNATURE_ALGORITHM = 'ed25519';
const ED25519_SIGNATURE_BYTES = 64;
const SEMVER = /^\d+\.\d+\.\d+$/;

function boundedId(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.length <= 256 ? text : '';
}

function policyDigestOf({ knowledgeId, version, workspaceId, content }) {
  return sha256Hex(stableStringify({ knowledgeId, version, workspaceId, content }));
}

function canonicalPolicySealPayload({ knowledgeId, version, workspaceId, policyDigest, issuedAt, transparency } = {}) {
  return {
    schemaVersion: POLICY_SEAL_VERSION,
    kind: 'policy',
    knowledgeId: String(knowledgeId || ''),
    version: String(version || ''),
    workspaceId: String(workspaceId || ''),
    policyDigest: String(policyDigest || ''),
    issuedAt: String(issuedAt || ''),
    transparency: transparency && typeof transparency === 'object'
      ? {
        log: String(transparency.log || ''),
        leafIndex: transparency.leafIndex === undefined || transparency.leafIndex === null
          ? null
          : String(transparency.leafIndex),
        integratedAt: String(transparency.integratedAt || ''),
      }
      : null,
  };
}

function sealHash(payload) {
  return `sha256:${crypto.createHash('sha256').update(stableStringify(payload), 'utf8').digest('hex')}`;
}

/**
 * Seal a K0 policy object. Returns null on anything malformed; a caller
 * configured to seal fails loudly rather than storing an unsealed policy
 * that looks sealed.
 */
function sealPolicy(policy, { privateKeyPem, issuedAt = '', transparency = null } = {}) {
  if (typeof privateKeyPem !== 'string' || !privateKeyPem) return null;
  if (!policy || typeof policy !== 'object') return null;
  if (policy.kind !== undefined && policy.kind !== null && policy.kind !== 'policy') return null;
  const knowledgeId = boundedId(policy.knowledgeId);
  const workspaceId = boundedId(policy.workspaceId);
  const version = typeof policy.version === 'string' ? policy.version.trim() : '';
  if (!knowledgeId || !workspaceId || !SEMVER.test(version)) return null;
  if (policy.content === undefined) return null;
  let payloadIssuedAt = String(issuedAt || '').trim();
  if (!payloadIssuedAt) return null;
  if (!Number.isFinite(Date.parse(payloadIssuedAt))) return null;
  const payload = canonicalPolicySealPayload({
    knowledgeId,
    version,
    workspaceId,
    policyDigest: policyDigestOf({ knowledgeId, version, workspaceId, content: policy.content }),
    issuedAt: payloadIssuedAt,
    transparency,
  });
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

function fail(reason, extra = {}) {
  return Object.freeze({ ok: false, reason, keyId: extra.keyId || '' });
}

/**
 * Verify a sealed policy against the policy object it authorizes.
 * `policy` is the presented object; its digest must match the sealed one.
 * `evidenceAt` is the time of the evidence the seal is presented with.
 */
function verifySealedPolicy(sealed, policy, {
  publicKeyPem = '', evidenceAt = '', toleranceMs = 0, allowMissingTransparency = false,
} = {}) {
  if (!sealed || typeof sealed !== 'object') return fail('malformed_sealed_policy');
  if (sealed.schemaVersion !== POLICY_SEAL_VERSION) return fail('unsupported_schema');
  if (sealed.kind !== 'policy') return fail('malformed_sealed_policy');
  if (sealed.algorithm !== SIGNATURE_ALGORITHM) return fail('unsupported_algorithm');
  if (typeof sealed.signature !== 'string' || !sealed.signature) return fail('missing_signature');
  if (typeof publicKeyPem !== 'string' || !publicKeyPem) return fail('no_public_key');

  const fingerprint = issuerKeyFingerprint(publicKeyPem);
  if (!fingerprint) return fail('unsupported_public_key');
  if (sealed.keyId !== fingerprint) return fail('key_fingerprint_mismatch');

  const payload = canonicalPolicySealPayload(sealed);
  if (sealHash(payload) !== sealed.sealHash) return fail('seal_hash_mismatch');

  try {
    const key = crypto.createPublicKey(publicKeyPem);
    const signature = Buffer.from(sealed.signature, 'base64');
    if (signature.length !== ED25519_SIGNATURE_BYTES) return fail('malformed_signature');
    const verified = crypto.verify(null, Buffer.from(stableStringify(payload), 'utf8'), key, signature);
    if (!verified) return fail('signature_invalid');
  } catch (_) {
    return fail('signature_invalid');
  }

  if (!policy || typeof policy !== 'object') return fail('policy_not_presented');
  const presentedDigest = policyDigestOf({
    knowledgeId: boundedId(policy.knowledgeId),
    version: typeof policy.version === 'string' ? policy.version.trim() : '',
    workspaceId: boundedId(policy.workspaceId),
    content: policy.content,
  });
  if (presentedDigest !== sealed.policyDigest
    || boundedId(policy.knowledgeId) !== sealed.knowledgeId
    || String(policy.version || '').trim() !== sealed.version
    || boundedId(policy.workspaceId) !== sealed.workspaceId) {
    return fail('policy_digest_mismatch', { keyId: sealed.keyId });
  }

  const sealTime = Date.parse(sealed.issuedAt);
  if (!Number.isFinite(sealTime)) return fail('seal_issued_at_invalid', { keyId: sealed.keyId });
  const evidenceTime = evidenceAt ? Date.parse(evidenceAt) : Date.now();
  if (!Number.isFinite(evidenceTime)) return fail('evidence_at_invalid', { keyId: sealed.keyId });
  const tolerance = Number.isFinite(Number(toleranceMs)) && Number(toleranceMs) >= 0 ? Number(toleranceMs) : 0;
  if (sealTime > Date.now() + tolerance) return fail('seal_issued_in_future', { keyId: sealed.keyId });
  if (sealTime > evidenceTime + tolerance) return fail('seal_issued_after_evidence', { keyId: sealed.keyId });

  const transparency = sealed.transparency;
  if (!transparency || !transparency.log || !transparency.integratedAt) {
    if (allowMissingTransparency !== true) return fail('missing_transparency_evidence', { keyId: sealed.keyId });
  } else {
    const integratedTime = Date.parse(transparency.integratedAt);
    if (!Number.isFinite(integratedTime)) return fail('transparency_evidence_malformed', { keyId: sealed.keyId });
    if (integratedTime < sealTime - tolerance) return fail('transparency_predates_issuance', { keyId: sealed.keyId });
  }

  return Object.freeze({
    ok: true,
    reason: '',
    keyId: sealed.keyId,
    knowledgeId: sealed.knowledgeId,
    version: sealed.version,
    issuedAt: sealed.issuedAt,
    ageMs: evidenceTime - sealTime,
    transparencyWitnessed: Boolean(transparency && transparency.log && transparency.integratedAt),
  });
}

module.exports = Object.freeze({
  POLICY_SEAL_VERSION,
  canonicalPolicySealPayload,
  policyDigestOf,
  sealHash,
  sealPolicy,
  verifySealedPolicy,
});
