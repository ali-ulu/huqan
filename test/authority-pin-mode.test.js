'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { parseAuthorityPin } = require('../lib/authority/authority-pin');
const { resolveApprovalAuthorityMode, DEFAULT_WINDOWS_PIN_PATH, DEFAULT_WINDOWS_INSTALL_DIR } = require('../lib/authority/authority-mode');
const { keyIdFor } = require('../lib/authority/decision-envelope');

function pinText(overrides = {}) {
  const signing = crypto.generateKeyPairSync('ed25519');
  const sealing = crypto.generateKeyPairSync('x25519');
  const signingKey = signing.publicKey.export({ type: 'spki', format: 'pem' });
  return JSON.stringify({ v: 'huqan.authority.pin.v1', port: 47821, keyId: keyIdFor(signingKey), signingKey,
    sealingKey: sealing.publicKey.export({ type: 'spki', format: 'pem' }), ...overrides });
}

test('a well-formed pin parses into checked keys', () => {
  const result = parseAuthorityPin(pinText());
  assert.equal(result.ok, true);
  assert.equal(result.pin.port, 47821);
  assert.equal(result.pin.signingKey.asymmetricKeyType, 'ed25519');
  assert.equal(result.pin.sealingKey.asymmetricKeyType, 'x25519');
});

test('a pin whose keyId does not match its key, or with the wrong key types, is refused', () => {
  assert.deepEqual(parseAuthorityPin(pinText({ keyId: '0'.repeat(16) })), { ok: false, reason: 'key_id_mismatch' });
  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  assert.equal(parseAuthorityPin(pinText({ sealingKey: publicKey.export({ type: 'spki', format: 'pem' }) })).ok, false);
  for (const text of ['', '{', pinText({ v: 'other' }), pinText({ port: 0 }), pinText({ port: 70000 })]) {
    assert.equal(parseAuthorityPin(text).ok, false, text.slice(0, 30));
  }
});

function resolver({ files = {}, env = {}, platform = 'win32' } = {}) {
  return resolveApprovalAuthorityMode({
    platform,
    readEnv: name => env[name],
    lstat: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    readFile: (file) => {
      if (!(file in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files[file];
    },
  });
}

test('with the installed pin the runtime is in service mode, whatever the environment says', () => {
  const files = { [DEFAULT_WINDOWS_PIN_PATH]: pinText(), 'C:/elsewhere/pin.json': pinText() };
  for (const env of [{}, { APPROVAL_AUTHORITY: 'legacy' }, { APPROVAL_AUTHORITY: 'off' },
    { AUTHORITY_PIN_PATH: 'C:/elsewhere/pin.json' }]) {
    const mode = resolver({ files, env });
    assert.equal(mode.mode, 'service', JSON.stringify(env));
    assert.equal(mode.pinPath, DEFAULT_WINDOWS_PIN_PATH, 'an override cannot swap in another authority');
  }
});

test('without a pin the runtime stays in legacy mode and says the boundary is the same user', () => {
  assert.deepEqual(resolver(), { mode: 'legacy', boundary: 'same-user' });
  assert.deepEqual(resolver({ platform: 'linux' }), { mode: 'legacy', boundary: 'same-user' });
});

test('an override pin adds an authority where none is installed, and required fails closed without one', () => {
  const mode = resolver({ files: { '/srv/pin.json': pinText() }, env: { AUTHORITY_PIN_PATH: '/srv/pin.json' }, platform: 'linux' });
  assert.equal(mode.mode, 'service');
  assert.equal(mode.pinPath, '/srv/pin.json');
  assert.deepEqual(resolver({ env: { APPROVAL_AUTHORITY: 'required' } }),
    { mode: 'required_unavailable', reason: 'no_pin' });
});

test('an installed pin that cannot be read or trusted fails closed instead of falling back to legacy', () => {
  assert.deepEqual(resolver({ files: { [DEFAULT_WINDOWS_PIN_PATH]: '{' } }),
    { mode: 'required_unavailable', reason: 'pin_malformed', pinPath: DEFAULT_WINDOWS_PIN_PATH });
  const unreadable = resolveApprovalAuthorityMode({ platform: 'win32', readEnv: () => undefined,
    readFile: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } });
  assert.equal(unreadable.mode, 'required_unavailable');
  assert.equal(unreadable.reason, 'pin_unreadable');
});

test('an install path that is a junction or cannot be inspected fails closed', () => {
  const linkAt = target => resolveApprovalAuthorityMode({ platform: 'win32', readEnv: () => undefined,
    readFile: () => pinText(), lstat: file => ({ isSymbolicLink: () => file === target }) });
  for (const target of [DEFAULT_WINDOWS_INSTALL_DIR, path.win32.join(DEFAULT_WINDOWS_INSTALL_DIR, 'public'), DEFAULT_WINDOWS_PIN_PATH]) {
    assert.deepEqual([linkAt(target).mode, linkAt(target).reason], ['required_unavailable', 'install_path_linked'], target);
  }
  const denied = resolveApprovalAuthorityMode({ platform: 'win32', readEnv: () => undefined, readFile: () => pinText(),
    lstat: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } });
  assert.equal(denied.reason, 'install_path_linked');
});

test('an installed pin reports an OS boundary; an override pin reports that the environment chose it', () => {
  assert.equal(resolver({ files: { [DEFAULT_WINDOWS_PIN_PATH]: pinText() } }).boundary, 'os-service');
  assert.equal(resolver({ files: { '/srv/pin.json': pinText() }, env: { AUTHORITY_PIN_PATH: '/srv/pin.json' } }).boundary,
    'env-override');
});

test('a pin written with a byte-order mark still parses', () => {
  assert.equal(parseAuthorityPin(`﻿${pinText()}`).ok, true);
});
