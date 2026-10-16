'use strict';

const crypto = require('node:crypto');
const { stableStringify } = require('./canonical-receipt');

const SIGNATURE_SCHEMA_VERSION = 'huqan.receipt-bundle-signature.v1';
const SIGNATURE_SCHEMA_VERSION_V2 = 'huqan.receipt-bundle-signature.v2';

function canonicalBundleSignaturePayload(bundle) {
  return {
    schemaVersion: SIGNATURE_SCHEMA_VERSION,
    sealVersion: bundle.sealVersion,
    bundleHash: bundle.bundleHash,
    workspaceId: bundle.workspaceId,
    receiptCount: bundle.receiptCount,
  };
}

/**
 * v2 payload (#3608): binds the bundle digest under its new name plus the
 * export time and the bundle envelope version, so a signed bundle cannot be
 * relabelled to another export time or schema version without breaking the
 * signature. Returns null when the bundle carries no digest to bind --
 * callers must refuse, never default.
 */
function canonicalBundleSignaturePayloadV2(bundle) {
  if (!bundle || typeof bundle !== 'object') return null;
  if (typeof bundle.bundleHash !== 'string' || !bundle.bundleHash) return null;
  if (typeof bundle.exportedAt !== 'string' || !bundle.exportedAt) return null;
  if (typeof bundle.schemaVersion !== 'string' || !bundle.schemaVersion) return null;
  return {
    schemaVersion: SIGNATURE_SCHEMA_VERSION_V2,
    sealVersion: bundle.sealVersion,
    bundleDigest: bundle.bundleHash,
    bundleSchemaVersion: bundle.schemaVersion,
    exportedAt: bundle.exportedAt,
    workspaceId: bundle.workspaceId,
    receiptCount: bundle.receiptCount,
  };
}

function normalizeSignatureVersion(version) {
  if (version === SIGNATURE_SCHEMA_VERSION_V2 || version === 'v2') return SIGNATURE_SCHEMA_VERSION_V2;
  if (version === SIGNATURE_SCHEMA_VERSION || version === 'v1') return SIGNATURE_SCHEMA_VERSION;
  return SIGNATURE_SCHEMA_VERSION_V2;
}

function signReceiptBundle(bundle, { keyReference, privateKeyPem, signatureVersion } = {}) {
  if (!bundle || typeof bundle !== 'object' || typeof keyReference !== 'string' || !keyReference || typeof privateKeyPem !== 'string') return null;
  try {
    const key = crypto.createPrivateKey(privateKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') return null;
    const version = normalizeSignatureVersion(signatureVersion);
    const payload = version === SIGNATURE_SCHEMA_VERSION_V2
      ? canonicalBundleSignaturePayloadV2(bundle)
      : canonicalBundleSignaturePayload(bundle);
    if (!payload) return null;
    return Object.freeze({ schemaVersion: version, algorithm: 'ed25519', keyReference,
      signature: crypto.sign(null, Buffer.from(stableStringify(payload), 'utf8'), key).toString('base64') });
  } catch (_) { return null; }
}

function verifyV1(bundle, envelope, publicKeyPem) {
  try {
    const key = crypto.createPublicKey(publicKeyPem);
    const signature = Buffer.from(envelope.signature, 'base64');
    return key.asymmetricKeyType === 'ed25519' && signature.length === 64
      && crypto.verify(null, Buffer.from(stableStringify(canonicalBundleSignaturePayload(bundle)), 'utf8'), key, signature);
  } catch (_) { return false; }
}

function verifyV2(bundle, envelope, publicKeyPem) {
  const payload = canonicalBundleSignaturePayloadV2(bundle);
  if (!payload) return false;
  try {
    const key = crypto.createPublicKey(publicKeyPem);
    const signature = Buffer.from(envelope.signature, 'base64');
    return key.asymmetricKeyType === 'ed25519' && signature.length === 64
      && crypto.verify(null, Buffer.from(stableStringify(payload), 'utf8'), key, signature);
  } catch (_) { return false; }
}

function verifyReceiptBundleSignature(bundle, envelope, publicKeyPem) {
  if (!bundle || typeof bundle !== 'object' || !envelope || typeof envelope.signature !== 'string' || envelope.algorithm !== 'ed25519') return false;
  if (envelope.schemaVersion === SIGNATURE_SCHEMA_VERSION) return verifyV1(bundle, envelope, publicKeyPem);
  if (envelope.schemaVersion === SIGNATURE_SCHEMA_VERSION_V2) return verifyV2(bundle, envelope, publicKeyPem);
  return false;
}

module.exports = Object.freeze({ SIGNATURE_SCHEMA_VERSION, SIGNATURE_SCHEMA_VERSION_V2, canonicalBundleSignaturePayload, canonicalBundleSignaturePayloadV2, signReceiptBundle, verifyReceiptBundleSignature });
