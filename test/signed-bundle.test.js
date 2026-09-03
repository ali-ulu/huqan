'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { signReceiptBundle, verifyReceiptBundleSignature } = require('../lib/receipt/signed-bundle');
test('signs the immutable bundle binding with ed25519', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519'); const bundle = { sealVersion: 'huqan-bundle-seal-v2', bundleHash: 'a'.repeat(64), workspaceId: 'default', receiptCount: 1 };
  const signed = signReceiptBundle(bundle, { keyReference: 'key:test', privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() });
  assert.equal(signed.algorithm, 'ed25519'); assert.equal(signed.keyReference, 'key:test'); assert.equal(Buffer.from(signed.signature, 'base64').length, 64);
  assert.equal(verifyReceiptBundleSignature(bundle, signed, publicKey.export({ type: 'spki', format: 'pem' }).toString()), true); assert.equal(verifyReceiptBundleSignature({ ...bundle, bundleHash: 'b'.repeat(64) }, signed, publicKey.export({ type: 'spki', format: 'pem' }).toString()), false);
});
