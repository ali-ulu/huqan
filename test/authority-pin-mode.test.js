'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { parseAuthorityPin } = require('../lib/authority/authority-pin');
const { resolveApprovalAuthorityMode, DEFAULT_WINDOWS_PIN_PATH, DEFAULT_WINDOWS_INSTALL_DIR } = require('../lib/authority/authority-mode');
const { checkInstallTrust } = require('../lib/authority/install-trust');
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

function resolver({ files = {}, env = {}, platform = 'win32', trust = { ok: true }, posixTrust = { ok: true } } = {}) {
  return resolveApprovalAuthorityMode({
    platform,
    readEnv: name => env[name],
    lstat: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    readFile: (file) => {
      if (!(file in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files[file];
    },
    checkTrust: () => trust,
    checkPosixTrust: () => posixTrust,
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

test('a parsed pin from an untrusted install directory fails closed, never legacy', () => {
  const mode = resolver({ files: { [DEFAULT_WINDOWS_PIN_PATH]: pinText() }, trust: { ok: false, reason: 'install_path_untrusted' } });
  assert.deepEqual([mode.mode, mode.reason, mode.pinPath],
    ['required_unavailable', 'install_path_untrusted', DEFAULT_WINDOWS_PIN_PATH]);
});

test('a trust check that throws fails closed instead of falling back to legacy', () => {
  const mode = resolveApprovalAuthorityMode({ platform: 'win32', readEnv: () => undefined,
    readFile: () => pinText(),
    lstat: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    checkTrust: () => { throw new Error('probe failed'); } });
  assert.equal(mode.mode, 'required_unavailable');
});

test('without a pin the trust check never runs, so legacy needs no probe', () => {
  let calls = 0;
  const mode = resolveApprovalAuthorityMode({ platform: 'win32', readEnv: () => undefined,
    readFile: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    lstat: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    checkTrust: () => { calls += 1; return { ok: true }; } });
  assert.equal(mode.mode, 'legacy');
  assert.equal(calls, 0);
});

function aclProbe(entries) {
  return () => ({ error: null, status: 0, stdout: JSON.stringify(entries) });
}

function lockedEntry(path, owner = 'S-1-5-18') {
  return { path, owner, access: [
    { sid: 'S-1-5-18', rights: 'FullControl', type: 'Allow' },
    { sid: 'S-1-5-32-544', rights: 'FullControl', type: 'Allow' },
    { sid: 'S-1-5-32-545', rights: 'ReadAndExecute, Synchronize', type: 'Allow' },
  ] };
}

const PROBE_PATHS = ['C:\\ProgramData\\huqan-authority', 'C:\\ProgramData\\huqan-authority\\public',
  'C:\\ProgramData\\huqan-authority\\public\\authority.json'];

test('a locked install tree is trusted', () => {
  const trust = checkInstallTrust({ spawn: aclProbe(PROBE_PATHS.map(p => lockedEntry(p))) });
  assert.deepEqual(trust, { ok: true });
});

test('a planted directory owned by the planter is refused', () => {
  const entries = PROBE_PATHS.map(p => lockedEntry(p));
  entries[0] = lockedEntry(PROBE_PATHS[0], 'S-1-5-21-111-222-333-1001');
  assert.equal(checkInstallTrust({ spawn: aclProbe(entries) }).reason, 'install_path_untrusted');
});

test('a write grant to Users anywhere on the path is refused', () => {
  const entries = PROBE_PATHS.map(p => lockedEntry(p));
  entries[1].access.push({ sid: 'S-1-5-32-545', rights: 'WriteData, Synchronize', type: 'Allow' });
  assert.equal(checkInstallTrust({ spawn: aclProbe(entries) }).reason, 'install_path_untrusted');
});

test('a probe that cannot run, or answers garbage, fails closed', () => {
  assert.equal(checkInstallTrust({ spawn: () => ({ error: new Error('no powershell'), status: 1, stdout: '' }) }).reason,
    'install_path_untrusted');
  assert.equal(checkInstallTrust({ spawn: () => ({ error: null, status: 0, stdout: 'not json' }) }).reason,
    'install_path_untrusted');
  assert.equal(checkInstallTrust({ spawn: () => ({ error: null, status: 0, stdout: '[]' }) }).reason,
    'install_path_untrusted');
});

const POSIX_PINS = Object.freeze({
  linux: '/var/lib/huqan-authority/public/authority.json',
  darwin: '/Library/HUQAN/authority-data/public/authority.json',
});

test('a trusted POSIX pin installs the service boundary, per platform (#4082)', () => {
  for (const [platform, pinPath] of Object.entries(POSIX_PINS)) {
    const mode = resolver({ platform, files: { [pinPath]: pinText() } });
    assert.deepEqual([mode.mode, mode.boundary, mode.pinPath], ['service', 'os-service', pinPath], platform);
  }
});

test('the POSIX layout is fixed in source, so an override cannot swap in another authority (#4082)', () => {
  const mode = resolver({ platform: 'linux', files: { [POSIX_PINS.linux]: pinText(), '/srv/pin.json': pinText() },
    env: { AUTHORITY_PIN_PATH: '/srv/pin.json' } });
  assert.equal(mode.mode, 'service');
  assert.equal(mode.pinPath, POSIX_PINS.linux, 'the env override cannot replace an installed POSIX pin');
});

test('a POSIX pin that is installed but not trusted fails closed, never legacy (#4082)', () => {
  const mode = resolver({ platform: 'linux', files: { [POSIX_PINS.linux]: pinText() },
    posixTrust: { ok: false, reason: 'install_path_untrusted' } });
  assert.deepEqual([mode.mode, mode.reason, mode.pinPath],
    ['required_unavailable', 'install_path_untrusted', POSIX_PINS.linux]);
});

test('a POSIX install path that is a link fails closed before the pin is read (#4082)', () => {
  const linkAt = target => resolveApprovalAuthorityMode({ platform: 'darwin', readEnv: () => undefined,
    readFile: () => pinText(), lstat: file => ({ isSymbolicLink: () => file === target }) });
  for (const target of ['/Library/HUQAN/authority-data', '/Library/HUQAN/authority-data/public', POSIX_PINS.darwin]) {
    assert.deepEqual([linkAt(target).mode, linkAt(target).reason], ['required_unavailable', 'install_path_linked'], target);
  }
});

test('without a POSIX pin the runtime stays legacy, and an unknown platform is unchanged (#4082)', () => {
  assert.deepEqual(resolver({ platform: 'linux' }), { mode: 'legacy', boundary: 'same-user' });
  assert.deepEqual(resolver({ platform: 'darwin' }), { mode: 'legacy', boundary: 'same-user' });
  assert.deepEqual(resolver({ platform: 'freebsd' }), { mode: 'legacy', boundary: 'same-user' });
  const override = resolver({ platform: 'linux', files: { '/srv/pin.json': pinText() }, env: { AUTHORITY_PIN_PATH: '/srv/pin.json' } });
  assert.deepEqual([override.mode, override.boundary], ['service', 'env-override']);
});
