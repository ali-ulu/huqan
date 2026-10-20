'use strict';

// #4087 PR-2: the configuration surface that reads the public trust receipt
// signing key. The two behaviours below are the issue's PR-2 list, and each is
// a rule about *when* the deployment is allowed to start rather than a
// property of the key it reads.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  GITHUB_APP_PUBLIC_RECEIPT_KEY_ENV,
  GITHUB_APP_PUBLIC_RECEIPT_KEY_ID_ENV,
  readGitHubAppPublicReceiptConfig,
} = require('../lib/github-app-public-receipt-config');

const KEY_ID = 'c8-public-receipt';

function sandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-public-receipt-config-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeKey(root, name = 'public-receipt.pem') {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const file = path.join(root, name);
  fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), { mode: 0o600 });
  return file;
}

function environment(keyPath, keyId = KEY_ID) {
  // Canonical `HUQAN_` names: the bare suffix is deliberately not read by the
  // runtime (docs/environment-variable-migration.md), so a test that set it
  // would pass for the wrong reason.
  return {
    [`HUQAN_${GITHUB_APP_PUBLIC_RECEIPT_KEY_ENV}`]: keyPath,
    [`HUQAN_${GITHUB_APP_PUBLIC_RECEIPT_KEY_ID_ENV}`]: keyId,
  };
}

test('startup accepts an absent public receipt key', () => {
  assert.equal(readGitHubAppPublicReceiptConfig({}), null);
  assert.equal(readGitHubAppPublicReceiptConfig({ UNRELATED: '1' }), null);
});

test('startup fails closed when a configured public receipt key is unreadable, without printing its path', (t) => {
  const root = sandbox(t);
  const missing = path.join(root, 'absent-key.pem');

  let error;
  try {
    readGitHubAppPublicReceiptConfig(environment(missing));
  } catch (caught) {
    error = caught;
  }

  assert.ok(error, 'an unreadable configured key must refuse startup');
  assert.equal(error.code, 'GITHUB_APP_PUBLIC_RECEIPT_CONFIG_INVALID');
  assert.ok(!error.message.includes(missing), 'the key path must not be printed');
  assert.ok(!error.message.includes('absent-key'), 'no fragment of the key path may be printed');
  // The cause is attached, not formatted into the message: a misconfiguration
  // stays distinguishable from a bug in the reader without disclosing where the
  // key lives.
  assert.ok(error.cause instanceof Error, 'the cause is attached for diagnosis');
});

test('a configured key that is not Ed25519 refuses startup', (t) => {
  const root = sandbox(t);
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const file = path.join(root, 'rsa.pem');
  fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());

  assert.throws(
    () => readGitHubAppPublicReceiptConfig(environment(file)),
    (error) => error.code === 'GITHUB_APP_PUBLIC_RECEIPT_CONFIG_INVALID'
      && !error.message.includes(file),
  );
});

test('half a configuration refuses startup rather than publishing nothing', (t) => {
  const root = sandbox(t);
  const file = writeKey(root);

  assert.throws(
    () => readGitHubAppPublicReceiptConfig({ [`HUQAN_${GITHUB_APP_PUBLIC_RECEIPT_KEY_ENV}`]: file }),
    (error) => error.code === 'GITHUB_APP_PUBLIC_RECEIPT_CONFIG_INVALID',
  );
  assert.throws(
    () => readGitHubAppPublicReceiptConfig({ [`HUQAN_${GITHUB_APP_PUBLIC_RECEIPT_KEY_ID_ENV}`]: KEY_ID }),
    (error) => error.code === 'GITHUB_APP_PUBLIC_RECEIPT_CONFIG_INVALID',
  );
});

test('a readable Ed25519 key returns the exporter-ready signer', (t) => {
  const root = sandbox(t);
  const file = writeKey(root);

  const config = readGitHubAppPublicReceiptConfig(environment(file));
  assert.equal(config.keyId, KEY_ID);
  // The exporter requires a private Ed25519 KeyObject, not a PEM: returning one
  // here is what keeps an unusable key off the write path.
  assert.ok(config.privateKey instanceof crypto.KeyObject);
  assert.equal(config.privateKey.type, 'private');
  assert.equal(config.privateKey.asymmetricKeyType, 'ed25519');
});
