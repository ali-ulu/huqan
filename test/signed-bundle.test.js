'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { signReceiptBundle, verifyReceiptBundleSignature, canonicalBundleSignaturePayloadV2 } = require('../lib/receipt/signed-bundle');
const { exportReceiptBundle, verifyExportedBundle } = require('../lib/receipt/receipt-export');
test('signs the immutable bundle binding with ed25519', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519'); const bundle = { sealVersion: 'huqan-bundle-seal-v2', schemaVersion: 'v4-receipt-bundle-v1', exportedAt: '2026-01-01T00:00:00.000Z', bundleHash: 'a'.repeat(64), workspaceId: 'default', receiptCount: 1 };
  const signed = signReceiptBundle(bundle, { keyReference: 'key:test', privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() });
  assert.equal(signed.algorithm, 'ed25519'); assert.equal(signed.keyReference, 'key:test'); assert.equal(Buffer.from(signed.signature, 'base64').length, 64);
  assert.equal(verifyReceiptBundleSignature(bundle, signed, publicKey.export({ type: 'spki', format: 'pem' }).toString()), true); assert.equal(verifyReceiptBundleSignature({ ...bundle, bundleHash: 'b'.repeat(64) }, signed, publicKey.export({ type: 'spki', format: 'pem' }).toString()), false);
});

test('distinguishes valid unsigned bundles from valid signed bundles and rejects an absent signature when required', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const empty = exportReceiptBundle([], { exportedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(verifyExportedBundle(empty).signatureStatus, 'unsigned');
  assert.equal(verifyExportedBundle(empty).valid, true);
  assert.equal(verifyExportedBundle(empty, { requireSignature: true }).valid, false);
  const bundle = exportReceiptBundle([], { exportedAt: '2026-01-01T00:00:00.000Z', signing: { keyReference: 'registry:issuer-1', privateKeyPem } });
  const result = verifyExportedBundle(bundle, { resolveBundleSigningKey: (ref) => ref === 'registry:issuer-1' ? publicKeyPem : null, requireSignature: true });
  assert.equal(result.valid, true);
  assert.equal(result.signatureStatus, 'signed');
  assert.equal(verifyExportedBundle(bundle, { resolveBundleSigningKey: () => crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString() }).valid, false);
});

test('unknown envelope versions and malformed inputs are refused', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const bundle = exportReceiptBundle([], { exportedAt: '2026-01-01T00:00:00.000Z', signing: { keyReference: 'registry:issuer-1', privateKeyPem } });
  assert.equal(verifyReceiptBundleSignature(bundle, { ...bundle.bundleSignature, schemaVersion: 'huqan.receipt-bundle-signature.v9' }, publicKeyPem), false);
  assert.equal(verifyReceiptBundleSignature(bundle, { ...bundle.bundleSignature, algorithm: 'rsa' }, publicKeyPem), false);
  assert.equal(verifyReceiptBundleSignature(bundle, { ...bundle.bundleSignature, signature: 42 }, publicKeyPem), false);
  assert.equal(verifyReceiptBundleSignature(null, bundle.bundleSignature, publicKeyPem), false);
  assert.equal(verifyReceiptBundleSignature(bundle, null, publicKeyPem), false);
  assert.equal(verifyReceiptBundleSignature(bundle, bundle.bundleSignature, 'not-a-key'), false);
  const noExportedAt = structuredClone(bundle);
  delete noExportedAt.exportedAt;
  assert.equal(verifyReceiptBundleSignature(noExportedAt, noExportedAt.bundleSignature, publicKeyPem), false);
  assert.equal(canonicalBundleSignaturePayloadV2(null), null);
});

test('v2 envelope binds bundleDigest/exportedAt/schemaVersion and refuses a missing digest', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const bundle = exportReceiptBundle([], { exportedAt: '2026-01-01T00:00:00.000Z', signing: { keyReference: 'registry:issuer-1', privateKeyPem } });
  assert.equal(bundle.bundleSignature.schemaVersion, 'huqan.receipt-bundle-signature.v2');
  assert.equal(verifyExportedBundle(bundle, { resolveBundleSigningKey: () => publicKeyPem, requireSignature: true }).valid, true);
  const relabelled = structuredClone(bundle);
  relabelled.exportedAt = '2030-06-01T12:00:00.000Z';
  assert.equal(verifyReceiptBundleSignature(relabelled, relabelled.bundleSignature, publicKeyPem), false);
  const noDigest = structuredClone(bundle);
  delete noDigest.bundleHash;
  assert.equal(verifyReceiptBundleSignature(noDigest, noDigest.bundleSignature, publicKeyPem), false);
  const legacy = exportReceiptBundle([], { exportedAt: '2026-01-01T00:00:00.000Z', signing: { keyReference: 'registry:issuer-1', privateKeyPem, signatureVersion: 'v1' } });
  assert.equal(legacy.bundleSignature.schemaVersion, 'huqan.receipt-bundle-signature.v1');
  assert.equal(verifyReceiptBundleSignature(legacy, legacy.bundleSignature, publicKeyPem), true);
});

test('the stdlib-only Python verifier agrees with JS across v1 and v2 envelopes', () => {
  const python = process.platform === 'win32' ? 'py' : 'python3';
  const prefix = process.platform === 'win32' ? ['-3'] : [];
  if (spawnSync(python, [...prefix, '--version']).status !== 0) return;
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-signed-bundle-'));
  const bundlePath = path.join(directory, 'bundle.json');
  const keyPath = path.join(directory, 'issuer.pem');
  fs.writeFileSync(keyPath, publicKeyPem);
  const probe = path.join(__dirname, '..', 'specs', 'axiom-trust-protocol', '0.1', 'conformance', 'verify_bundle.py');
  const args = [...prefix, probe, `--public-key=registry:issuer-1=${keyPath}`, '--require-signature', bundlePath];
  try {
    for (const signatureVersion of ['v1', 'v2']) {
      const bundle = exportReceiptBundle([], { exportedAt: '2026-01-01T00:00:00.000Z', signing: { keyReference: 'registry:issuer-1', privateKeyPem, signatureVersion } });
      fs.writeFileSync(bundlePath, JSON.stringify(bundle));
      const result = spawnSync(python, args, { encoding: 'utf8' });
      assert.equal(result.status, 0, `${signatureVersion}: ${result.stderr}`);
      assert.match(result.stdout, /VALID \(signed by registry:issuer-1\)/);
    }
    const noDigest = exportReceiptBundle([], { exportedAt: '2026-01-01T00:00:00.000Z', signing: { keyReference: 'registry:issuer-1', privateKeyPem } });
    delete noDigest.bundleHash;
    fs.writeFileSync(bundlePath, JSON.stringify(noDigest));
    const refused = spawnSync(python, args, { encoding: 'utf8' });
    assert.equal(refused.status, 1);
    assert.match(refused.stdout, /INVALID/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('the stdlib-only Python verifier recognizes a signed bundle and rejects a bad signature', () => {
  const python = process.platform === 'win32' ? 'py' : 'python3';
  const prefix = process.platform === 'win32' ? ['-3'] : [];
  if (spawnSync(python, [...prefix, '--version']).status !== 0) return;
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const bundle = exportReceiptBundle([], { exportedAt: '2026-01-01T00:00:00.000Z', signing: { keyReference: 'registry:issuer-1', privateKeyPem } });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-signed-bundle-'));
  const bundlePath = path.join(directory, 'bundle.json');
  const keyPath = path.join(directory, 'issuer.pem');
  fs.writeFileSync(bundlePath, JSON.stringify(bundle)); fs.writeFileSync(keyPath, publicKeyPem);
  try {
    const probe = path.join(__dirname, '..', 'specs', 'axiom-trust-protocol', '0.1', 'conformance', 'verify_bundle.py');
    const args = [...prefix, probe, `--public-key=registry:issuer-1=${keyPath}`, '--require-signature', bundlePath];
    const result = spawnSync(python, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /VALID \(signed by registry:issuer-1\)/);
    const tampered = structuredClone(bundle);
    const alteredBytes = Buffer.from(tampered.bundleSignature.signature, 'base64');
    alteredBytes[0] ^= 1;
    tampered.bundleSignature.signature = alteredBytes.toString('base64');
    fs.writeFileSync(bundlePath, JSON.stringify(tampered));
    const rejected = spawnSync(python, args, { encoding: 'utf8' });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stdout, /INVALID \(invalid\).*signature_invalid/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
