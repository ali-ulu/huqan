'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAuthorityState, openAuthorityState } = require('../lib/authority/state-store');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-authstate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('created state reopens with the same keys and secret', (t) => {
  const dir = tempDir(t);
  const created = createAuthorityState({ dir });
  assert.equal(created.totpSecret.length, 20);
  const state = openAuthorityState({ dir });
  assert.equal(state.signingKey.asymmetricKeyType, 'ed25519');
  assert.equal(state.sealingKey.asymmetricKeyType, 'x25519');
  assert.deepEqual(state.totpSecret, created.totpSecret);
  assert.equal(crypto.createPublicKey(state.signingKey).export({ type: 'spki', format: 'pem' }), created.signingPublicKeyPem);
  assert.equal(crypto.createPublicKey(state.sealingKey).export({ type: 'spki', format: 'pem' }), created.sealingPublicKeyPem);
  assert.deepEqual(state.readTotp(), { lastCounter: -1, failures: [], lockedUntil: null });
});

test('creating over existing state is refused, so a re-run cannot rotate keys silently', (t) => {
  const dir = tempDir(t);
  const created = createAuthorityState({ dir });
  assert.throws(() => createAuthorityState({ dir }), /EEXIST|already/);
  assert.deepEqual(openAuthorityState({ dir }).totpSecret, created.totpSecret);
});

test('TOTP progress is written atomically and survives a reopen', (t) => {
  const dir = tempDir(t);
  createAuthorityState({ dir });
  const state = openAuthorityState({ dir });
  state.writeTotp({ lastCounter: 42, failures: [1000, 2000], lockedUntil: 5000 });
  assert.deepEqual(openAuthorityState({ dir }).readTotp(), { lastCounter: 42, failures: [1000, 2000], lockedUntil: 5000 });
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.includes('.tmp')), [], 'no temporary file is left behind');
});

test('malformed TOTP progress fails closed instead of resetting the replay counter', (t) => {
  const dir = tempDir(t);
  createAuthorityState({ dir });
  const state = openAuthorityState({ dir });
  for (const bad of [{ lastCounter: 'x', failures: [], lockedUntil: null }, { lastCounter: 1, failures: 'x', lockedUntil: null }]) {
    assert.throws(() => state.writeTotp(bad), TypeError);
  }
  fs.writeFileSync(path.join(dir, 'totp-progress.json'), '{"lastCounter":');
  assert.throws(() => openAuthorityState({ dir }).readTotp(), /progress/);
});
