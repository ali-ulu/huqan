'use strict';

// #4582 (R35 follow-up): loadTrustPolicy() can require a valid policy seal.
//
// A signed policy *object* already existed (lib/receipt/policy-seal.js,
// ADR-015); nothing required one on the file-loading path. This wires it in so
// a deployment that configures a public key refuses an unsigned or tampered
// trust-policy file. The requirement lives in deployment configuration, never
// in the file: an attacker who can rewrite the policy can also write
// `signatureRequired: false`.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { loadTrustPolicy } = require('../lib/trust-policy');
const { sealPolicy } = require('../lib/receipt/policy-seal');

const ISSUED_AT = '2026-08-19T10:00:00.000Z';
const TRANSPARENCY = { log: 'tlog:example', leafIndex: '41', integratedAt: '2026-08-19T10:00:05.000Z' };

function keys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

function weights() {
  return {
    version: '0.8.0',
    defaults: { user: 0.9, llm: 0.4 },
    github: { merged_pr: 0.8 },
    fallback: { unknown: 0.5 },
  };
}

function signedEnvelope(privateKeyPem, { transparency = TRANSPARENCY, content = weights() } = {}) {
  const subject = {
    kind: 'policy',
    knowledgeId: 'policy:trust-policy',
    version: '0.8.0',
    workspaceId: 'default',
    content,
  };
  const seal = sealPolicy(subject, { privateKeyPem, issuedAt: ISSUED_AT, transparency });
  assert.ok(seal, 'sealPolicy must produce a seal for a well-formed policy');
  return { ...subject, seal };
}

function withEnv(vars, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// A tmpdir holding the policy file and, when a key is supplied, the public key.
function fixture({ envelope, publicKeyPem }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-signed-policy-'));
  const policyPath = path.join(dir, 'trust-policy.json');
  fs.writeFileSync(policyPath, JSON.stringify(envelope));
  const env = { HUQAN_TRUST_POLICY_ROOTS: dir };
  if (publicKeyPem) {
    const keyPath = path.join(dir, 'trust-policy.pub.pem');
    fs.writeFileSync(keyPath, publicKeyPem);
    env.HUQAN_TRUST_POLICY_PUBLIC_KEY = keyPath;
  }
  return { dir, policyPath, env };
}

test('a sealed policy loads when the deployment configures a public key', () => {
  const { privateKeyPem, publicKeyPem } = keys();
  const { policyPath, env } = fixture({ envelope: signedEnvelope(privateKeyPem), publicKeyPem });
  withEnv(env, () => {
    const policy = loadTrustPolicy(policyPath);
    assert.equal(policy.version, '0.8.0');
    assert.deepEqual(policy.defaults, { user: 0.9, llm: 0.4 });
    // The weights are unwrapped; the envelope's identity fields do not leak.
    assert.equal(policy.seal, undefined);
    assert.equal(policy.knowledgeId, undefined);
  });
});

test('an unsigned policy is refused when a public key is configured', () => {
  const { publicKeyPem } = keys();
  const { policyPath, env } = fixture({ envelope: weights(), publicKeyPem });
  withEnv(env, () => {
    assert.throws(
      () => loadTrustPolicy(policyPath),
      (error) => error.code === 'TRUST_POLICY_SIGNATURE_REQUIRED',
    );
  });
});

test('a tampered policy body is refused', () => {
  const { privateKeyPem, publicKeyPem } = keys();
  const envelope = signedEnvelope(privateKeyPem);
  envelope.content = { ...envelope.content, defaults: { user: 0.1, llm: 0.4 } };
  const { policyPath, env } = fixture({ envelope, publicKeyPem });
  withEnv(env, () => {
    assert.throws(
      () => loadTrustPolicy(policyPath),
      (error) => error.code === 'TRUST_POLICY_SEAL_INVALID' && /policy_digest_mismatch/.test(error.message),
    );
  });
});

test('a seal made with another key is refused', () => {
  const signer = keys();
  const other = keys();
  const { policyPath, env } = fixture({ envelope: signedEnvelope(signer.privateKeyPem), publicKeyPem: other.publicKeyPem });
  withEnv(env, () => {
    assert.throws(
      () => loadTrustPolicy(policyPath),
      (error) => error.code === 'TRUST_POLICY_SEAL_INVALID' && /key_fingerprint_mismatch/.test(error.message),
    );
  });
});

test('without a configured public key the loader is unchanged', () => {
  const { policyPath, env } = fixture({ envelope: weights() });
  withEnv(env, () => {
    const policy = loadTrustPolicy(policyPath);
    assert.equal(policy.version, '0.8.0');
    assert.deepEqual(policy.defaults, { user: 0.9, llm: 0.4 });
  });
});

test('a configured but unreadable public key fails closed', () => {
  const { dir, policyPath } = fixture({ envelope: weights() });
  withEnv({ HUQAN_TRUST_POLICY_ROOTS: dir, HUQAN_TRUST_POLICY_PUBLIC_KEY: path.join(dir, 'missing.pem') }, () => {
    assert.throws(
      () => loadTrustPolicy(policyPath),
      (error) => error.code === 'TRUST_POLICY_CONFIG_INVALID',
    );
  });
});

test('transparency evidence is required unless the deployment opts out', () => {
  const { privateKeyPem, publicKeyPem } = keys();
  const { policyPath, env } = fixture({ envelope: signedEnvelope(privateKeyPem, { transparency: null }), publicKeyPem });

  withEnv(env, () => {
    assert.throws(
      () => loadTrustPolicy(policyPath),
      (error) => error.code === 'TRUST_POLICY_SEAL_INVALID' && /missing_transparency_evidence/.test(error.message),
    );
  });

  withEnv({ ...env, HUQAN_TRUST_POLICY_ALLOW_MISSING_TRANSPARENCY: 'true' }, () => {
    const policy = loadTrustPolicy(policyPath);
    assert.equal(policy.version, '0.8.0');
  });
});

test('signatureRequired in the file demands a seal even without a configured key', () => {
  const { policyPath, env } = fixture({ envelope: { ...weights(), signatureRequired: true } });
  withEnv(env, () => {
    assert.throws(
      () => loadTrustPolicy(policyPath),
      (error) => error.code === 'TRUST_POLICY_CONFIG_INVALID',
    );
  });
});

test('signatureRequired in the file is satisfied by a valid seal', () => {
  const { privateKeyPem, publicKeyPem } = keys();
  const envelope = { ...signedEnvelope(privateKeyPem), signatureRequired: true };
  const { policyPath, env } = fixture({ envelope, publicKeyPem });
  withEnv(env, () => {
    const policy = loadTrustPolicy(policyPath);
    assert.equal(policy.version, '0.8.0');
    assert.deepEqual(policy.defaults, { user: 0.9, llm: 0.4 });
  });
});

test('a shipped seal is never silently dropped when no key is configured', () => {
  const { privateKeyPem } = keys();
  const { policyPath, env } = fixture({ envelope: signedEnvelope(privateKeyPem) });
  withEnv(env, () => {
    assert.throws(
      () => loadTrustPolicy(policyPath),
      (error) => error.code === 'TRUST_POLICY_CONFIG_INVALID',
    );
  });
});
