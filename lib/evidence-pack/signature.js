// SPDX-License-Identifier: LicenseRef-HUQAN-Enterprise
'use strict';

/**
 * Evidence-pack manifest signature (#4092, PR-A4; ADR-015 addendum).
 *
 * The pack is signed with the issuer key the deployment already configured
 * (`lib/issuer-seal-config.js`): no new key, no new variable, no new signer.
 * What is signed is a domain-separated statement about the manifest
 * (`huqan.evidence-pack-signature.v1`), never the receipt-bundle signature
 * payloads, so a signature made for one cannot be replayed as the other.
 *
 * `keyId` is derived from the public key in the signature file and must equal
 * `manifest.producer.issuerKeyId`, which the packHash already seals. The public
 * key travels inside the pack, so the signature proves origin (these bytes were
 * signed by the holder of that key), not independence of the operator.
 */

const crypto = require('node:crypto');
const { stableStringify } = require('../hash-chain');
const { issuerKeyFingerprint } = require('../receipt/issuer-seal');

const PACK_SIGNATURE_SCHEMA_VERSION = 'huqan.evidence-pack-signature.v1';
const ED25519_SIGNATURE_BYTES = 64;

const SIGNATURE_NON_CLAIM = 'the issuer signature proves origin, not independence: the public key travels inside the pack and the issuing key lives on the operator host';

function packSignaturePayload(manifest) {
  return {
    schemaVersion: PACK_SIGNATURE_SCHEMA_VERSION,
    packHash: manifest.packHash,
    period: manifest.period,
    generatedAt: manifest.generatedAt,
  };
}

const payloadBytes = (manifest) => Buffer.from(stableStringify(packSignaturePayload(manifest)), 'utf8');

function publicKeyPemOf(privateKeyPem) {
  const key = crypto.createPrivateKey(privateKeyPem);
  return crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString();
}

/** keyId for a configured issuer key (what `manifest.producer.issuerKeyId` must carry). */
function issuerKeyIdOf(privateKeyPem) {
  return issuerKeyFingerprint(publicKeyPemOf(privateKeyPem));
}

/** Sign a sealed manifest (packHash already set). Returns the signature file content. */
function signPackManifest(manifest, privateKeyPem) {
  const publicKeyPem = publicKeyPemOf(privateKeyPem);
  return {
    schemaVersion: PACK_SIGNATURE_SCHEMA_VERSION,
    algorithm: 'ed25519',
    keyId: issuerKeyFingerprint(publicKeyPem),
    publicKeyPem,
    signature: crypto.sign(null, payloadBytes(manifest), crypto.createPrivateKey(privateKeyPem)).toString('base64'),
  };
}

/** @returns {{findings: string[], keyId: string|null}} empty findings means the signature holds. */
function verifyPackSignature(manifest, envelope) {
  const wellFormed = envelope && typeof envelope === 'object' && !Array.isArray(envelope)
    && envelope.schemaVersion === PACK_SIGNATURE_SCHEMA_VERSION && envelope.algorithm === 'ed25519'
    && typeof envelope.keyId === 'string' && typeof envelope.publicKeyPem === 'string'
    && typeof envelope.signature === 'string';
  if (!wellFormed) return { findings: ['signature_format_invalid'], keyId: null };

  const findings = [];
  const derived = issuerKeyFingerprint(envelope.publicKeyPem);
  if (!derived || derived !== envelope.keyId) findings.push('signature_key_id_mismatch');
  if (envelope.keyId !== manifest.producer?.issuerKeyId) findings.push('signature_producer_key_mismatch');
  const signature = Buffer.from(envelope.signature, 'base64');
  let ok = false;
  try {
    ok = signature.length === ED25519_SIGNATURE_BYTES
      && crypto.verify(null, payloadBytes(manifest), crypto.createPublicKey(envelope.publicKeyPem), signature);
  } catch (_) { ok = false; }
  if (!ok) findings.push('signature_invalid');
  return { findings, keyId: envelope.keyId };
}

module.exports = {
  PACK_SIGNATURE_SCHEMA_VERSION,
  SIGNATURE_NON_CLAIM,
  packSignaturePayload,
  issuerKeyIdOf,
  signPackManifest,
  verifyPackSignature,
};
