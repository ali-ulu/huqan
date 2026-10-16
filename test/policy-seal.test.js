'use strict';

// #3490 (R35): versioned, signed policy objects. The signature binds the
// policy's identity, its exact content, the signature time and the
// transparency evidence; verification binds the signature time to evidence.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { sealPolicy, verifySealedPolicy } = require('../lib/receipt/policy-seal');

function keys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

function policy(overrides = {}) {
  return {
    kind: 'policy',
    knowledgeId: 'policy:tool-allowlist',
    version: '1.2.0',
    workspaceId: 'workspace-a',
    content: { allow: ['huqan.status'], deny: ['huqan.exec'] },
    ...overrides,
  };
}

function transparency(overrides = {}) {
  return { log: 'tlog:example', leafIndex: '41', integratedAt: '2026-08-19T10:00:05.000Z', ...overrides };
}

const ISSUED_AT = '2026-08-19T10:00:00.000Z';
const EVIDENCE_AT = '2026-08-19T10:00:10.000Z';

test('a sealed policy verifies against the authorized object', () => {
  const { privateKeyPem, publicKeyPem } = keys();
  const sealed = sealPolicy(policy(), { privateKeyPem, issuedAt: ISSUED_AT, transparency: transparency() });
  assert.ok(sealed);
  assert.ok(sealed.keyId.startsWith('ed25519:'));
  const result = verifySealedPolicy(sealed, policy(), { publicKeyPem, evidenceAt: EVIDENCE_AT });
  assert.equal(result.ok, true);
  assert.equal(result.knowledgeId, 'policy:tool-allowlist');
  assert.equal(result.version, '1.2.0');
  assert.equal(result.ageMs, 10_000);
  assert.equal(result.transparencyWitnessed, true);
});

test('tampered content or identity is refused', () => {
  const { privateKeyPem, publicKeyPem } = keys();
  const sealed = sealPolicy(policy(), { privateKeyPem, issuedAt: ISSUED_AT, transparency: transparency() });
  const drifted = verifySealedPolicy(sealed, policy({ content: { allow: ['huqan.*'] } }), { publicKeyPem, evidenceAt: EVIDENCE_AT });
  assert.equal(drifted.ok, false);
  assert.equal(drifted.reason, 'policy_digest_mismatch');
  const rebased = verifySealedPolicy(sealed, policy({ version: '1.3.0' }), { publicKeyPem, evidenceAt: EVIDENCE_AT });
  assert.equal(rebased.ok, false);
  assert.equal(rebased.reason, 'policy_digest_mismatch');
});

test('a wrong key and a missing key fail closed', () => {
  const { privateKeyPem, publicKeyPem } = keys();
  const sealed = sealPolicy(policy(), { privateKeyPem, issuedAt: ISSUED_AT, transparency: transparency() });
  const other = keys().publicKeyPem;
  assert.equal(verifySealedPolicy(sealed, policy(), { publicKeyPem: other, evidenceAt: EVIDENCE_AT }).reason, 'key_fingerprint_mismatch');
  assert.equal(verifySealedPolicy(sealed, policy(), { evidenceAt: EVIDENCE_AT }).reason, 'no_public_key');
  assert.notEqual(other, publicKeyPem);
});

test('a seal from the future or post-dating the evidence is refused', () => {
  const { privateKeyPem, publicKeyPem } = keys();
  const sealed = sealPolicy(policy(), { privateKeyPem, issuedAt: '2099-01-01T00:00:00.000Z', transparency: transparency({ integratedAt: '2099-01-01T00:00:05.000Z' }) });
  assert.equal(verifySealedPolicy(sealed, policy(), { publicKeyPem, evidenceAt: EVIDENCE_AT }).reason, 'seal_issued_in_future');
  const stale = sealPolicy(policy(), { privateKeyPem, issuedAt: '2026-08-19T10:00:20.000Z', transparency: transparency({ integratedAt: '2026-08-19T10:00:25.000Z' }) });
  assert.equal(verifySealedPolicy(stale, policy(), { publicKeyPem, evidenceAt: EVIDENCE_AT }).reason, 'seal_issued_after_evidence');
});

test('transparency evidence is required unless explicitly allowed missing', () => {
  const { privateKeyPem, publicKeyPem } = keys();
  const sealed = sealPolicy(policy(), { privateKeyPem, issuedAt: ISSUED_AT });
  assert.equal(sealed.transparency, null);
  const refused = verifySealedPolicy(sealed, policy(), { publicKeyPem, evidenceAt: EVIDENCE_AT });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'missing_transparency_evidence');
  const allowed = verifySealedPolicy(sealed, policy(), { publicKeyPem, evidenceAt: EVIDENCE_AT, allowMissingTransparency: true });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.transparencyWitnessed, false);
});

test('an inclusion proof check joins the shape check when supplied', () => {
  const { privateKeyPem, publicKeyPem } = keys();
  const sealed = sealPolicy(policy(), { privateKeyPem, issuedAt: ISSUED_AT, transparency: transparency() });
  const proved = verifySealedPolicy(sealed, policy(), { publicKeyPem, evidenceAt: EVIDENCE_AT, verifyInclusion: () => ({ ok: true }) });
  assert.equal(proved.ok, true);
  assert.equal(proved.transparencyProofChecked, true);
  const unproved = verifySealedPolicy(sealed, policy(), { publicKeyPem, evidenceAt: EVIDENCE_AT, verifyInclusion: () => ({ ok: false, reason: 'inclusion_proof_missing' }) });
  assert.equal(unproved.ok, false);
  assert.equal(unproved.reason, 'missing_transparency_proof');
  const shapeOnly = verifySealedPolicy(sealed, policy(), { publicKeyPem, evidenceAt: EVIDENCE_AT });
  assert.equal(shapeOnly.ok, true);
  assert.equal(shapeOnly.transparencyProofChecked, false);
});

test('non-policy kinds and malformed versions never seal', () => {
  const { privateKeyPem } = keys();
  assert.equal(sealPolicy(policy({ kind: 'procedure' }), { privateKeyPem, issuedAt: ISSUED_AT }), null);
  assert.equal(sealPolicy(policy({ version: '1.2' }), { privateKeyPem, issuedAt: ISSUED_AT }), null);
  assert.equal(sealPolicy(policy(), { privateKeyPem: 'not-a-key', issuedAt: ISSUED_AT }), null);
});
