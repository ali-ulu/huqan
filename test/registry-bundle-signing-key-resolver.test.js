'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRegistryBundleSigningKeyResolver } = require('../lib/registry/registry-bundle-signing-key-resolver');
const huqan = require('..');
const { exportReceiptBundle, verifyExportedBundle } = require('../lib/receipt/receipt-export');

function material(status = 'active') {
  const pair = crypto.generateKeyPairSync('ed25519');
  const publicKeySpkiDer = pair.publicKey.export({ type: 'spki', format: 'der' });
  const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const now = '2026-01-01T00:00:00.000Z';
  return {
    now, privateKeyPem,
    registryRecord: { agentId: 'issuer', identityRef: 'identity:issuer', workspaceId: 'default', protocolVersion: '0.2', capabilityIds: ['bounded-exchange'], recordVersion: 1, authenticationRequired: true, trustRootReference: 'test-key:issuer', resolvedKeyState: 'active', resolvedReasonCategory: '' },
    trustedKeyRecords: [{ keyReference: 'test-key:issuer', status, expiresAt: '2030-01-01T00:00:00.000Z', publicKeySpkiDer }],
  };
}

test('registry bundle signing resolver is reachable from the public SDK root', () => {
  assert.equal(huqan.createRegistryBundleSigningKeyResolver, createRegistryBundleSigningKeyResolver);
});

test('registry resolution verifies a signed bundle through the admitted key only', () => {
  const fixture = material();
  const resolver = createRegistryBundleSigningKeyResolver({ registryRecord: fixture.registryRecord, trustedKeyRecords: fixture.trustedKeyRecords, evaluationTime: fixture.now });
  assert.match(resolver('test-key:issuer'), /BEGIN PUBLIC KEY/);
  const bundle = exportReceiptBundle([], { exportedAt: fixture.now, signing: { keyReference: 'test-key:issuer', privateKeyPem: fixture.privateKeyPem } });
  assert.equal(verifyExportedBundle(bundle, { resolveBundleSigningKey: resolver, requireSignature: true }).valid, true);
  assert.equal(resolver('another-active-key'), null);
});

test('a revoked registry key fails closed for an otherwise valid signed bundle', () => {
  const active = material();
  const bundle = exportReceiptBundle([], { exportedAt: active.now, signing: { keyReference: 'test-key:issuer', privateKeyPem: active.privateKeyPem } });
  const revoked = { ...active, trustedKeyRecords: active.trustedKeyRecords.map((record) => ({ ...record, status: 'revoked' })) };
  const resolver = createRegistryBundleSigningKeyResolver({ registryRecord: revoked.registryRecord, trustedKeyRecords: revoked.trustedKeyRecords, evaluationTime: revoked.now });
  assert.equal(verifyExportedBundle(bundle, { resolveBundleSigningKey: resolver, requireSignature: true }).valid, false);
});

test('external clean-room verifier resolves an admitted registry key and rejects its revocation', () => {
  const python = process.platform === 'win32' ? 'py' : 'python3';
  const prefix = process.platform === 'win32' ? ['-3'] : [];
  if (spawnSync(python, [...prefix, '--version']).status !== 0) return;
  const fixture = material();
  const bundle = exportReceiptBundle([], { exportedAt: fixture.now, signing: { keyReference: 'test-key:issuer', privateKeyPem: fixture.privateKeyPem } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-external-registry-'));
  const paths = { bundle: path.join(dir, 'bundle.json'), record: path.join(dir, 'record.json'), authority: path.join(dir, 'authority.json') };
  fs.writeFileSync(paths.bundle, JSON.stringify(bundle)); fs.writeFileSync(paths.record, JSON.stringify({ record: fixture.registryRecord }));
  const authority = { keys: fixture.trustedKeyRecords.map((key) => ({ ...key, publicKeySpkiDerBase64: key.publicKeySpkiDer.toString('base64'), publicKeySpkiDer: undefined })) };
  fs.writeFileSync(paths.authority, JSON.stringify(authority));
  const probe = path.join(__dirname, '..', 'specs', 'axiom-trust-protocol', '0.1', 'conformance', 'verify_bundle.py');
  const args = [...prefix, probe, `--registry-record=${paths.record}`, `--authority=${paths.authority}`, '--require-signature', paths.bundle];
  try {
    const valid = spawnSync(python, args, { encoding: 'utf8' });
    assert.equal(valid.status, 0, `${valid.stderr}\n${valid.stdout}`); assert.match(valid.stdout, /VALID \(signed by test-key:issuer\)/);
    authority.keys[0].status = 'revoked'; fs.writeFileSync(paths.authority, JSON.stringify(authority));
    const revoked = spawnSync(python, args, { encoding: 'utf8' });
    assert.equal(revoked.status, 1); assert.match(revoked.stdout, /registry key unavailable/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
