'use strict';

const crypto = require('node:crypto');
const { stableStringify } = require('./canonical-receipt');

const SIGNATURE_SCHEMA_VERSION = 'huqan.receipt-bundle-signature.v1';

function canonicalBundleSignaturePayload(bundle) {
  return {
    schemaVersion: SIGNATURE_SCHEMA_VERSION,
    sealVersion: bundle.sealVersion,
    bundleHash: bundle.bundleHash,
    workspaceId: bundle.workspaceId,
    receiptCount: bundle.receiptCount,
  };
}

function signReceiptBundle(bundle, { keyReference, privateKeyPem } = {}) {
  if (!bundle || typeof bundle !== 'object' || typeof keyReference !== 'string' || !keyReference || typeof privateKeyPem !== 'string') return null;
  try {
    const key = crypto.createPrivateKey(privateKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') return null;
    return Object.freeze({ schemaVersion: SIGNATURE_SCHEMA_VERSION, algorithm: 'ed25519', keyReference,
      signature: crypto.sign(null, Buffer.from(stableStringify(canonicalBundleSignaturePayload(bundle)), 'utf8'), key).toString('base64') });
  } catch (_) { return null; }
}

function verifyReceiptBundleSignature(bundle, envelope, publicKeyPem) {
  if (!bundle || typeof bundle !== 'object' || !envelope || envelope.schemaVersion !== SIGNATURE_SCHEMA_VERSION || envelope.algorithm !== 'ed25519' || typeof envelope.signature !== 'string') return false;
  try {
    const key = crypto.createPublicKey(publicKeyPem);
    const signature = Buffer.from(envelope.signature, 'base64');
    return key.asymmetricKeyType === 'ed25519' && signature.length === 64
      && crypto.verify(null, Buffer.from(stableStringify(canonicalBundleSignaturePayload(bundle)), 'utf8'), key, signature);
  } catch (_) { return false; }
}

module.exports = Object.freeze({ SIGNATURE_SCHEMA_VERSION, canonicalBundleSignaturePayload, signReceiptBundle, verifyReceiptBundleSignature });
