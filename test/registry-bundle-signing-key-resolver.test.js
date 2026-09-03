'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createRegistryBundleSigningKeyResolver } = require('../lib/registry/registry-bundle-signing-key-resolver');
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
