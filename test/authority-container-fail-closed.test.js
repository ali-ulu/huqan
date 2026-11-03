'use strict';

// ADR-021 section 4 (#4484): inside a container no resolution path may claim
// an OS boundary. A detected container, or a probe that cannot tell, resolves
// `required_unavailable` before any pin is read or trusted.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { resolveApprovalAuthorityMode } = require('../lib/authority/authority-mode');
const { probeContainer } = require('../lib/container-detection');
const { keyIdFor } = require('../lib/authority/decision-envelope');

const LINUX_PIN = '/var/lib/huqan-authority/public/authority.json';

function pinText() {
  const signing = crypto.generateKeyPairSync('ed25519');
  const sealing = crypto.generateKeyPairSync('x25519');
  const signingKey = signing.publicKey.export({ type: 'spki', format: 'pem' });
  return JSON.stringify({ v: 'huqan.authority.pin.v1', port: 47821, keyId: keyIdFor(signingKey), signingKey,
    sealingKey: sealing.publicKey.export({ type: 'spki', format: 'pem' }) });
}

function resolve({ container, files = {}, env = {}, platform = 'linux' }) {
  let trustChecked = false;
  const mode = resolveApprovalAuthorityMode({
    platform,
    readEnv: name => env[name],
    lstat: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    readFile: (file) => {
      if (!(file in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files[file];
    },
    checkTrust: () => { trustChecked = true; return { ok: true }; },
    checkPosixTrust: () => { trustChecked = true; return { ok: true }; },
    probeContainer: typeof container === 'function' ? container : () => container,
  });
  return { mode, trustChecked };
}

test('outside a container a trusted pin still resolves os-service (control)', () => {
  const { mode } = resolve({ container: 'absent', files: { [LINUX_PIN]: pinText() } });
  assert.equal(mode.mode, 'service');
  assert.equal(mode.boundary, 'os-service');
});

test('a container with a trusted pin is required_unavailable, never os-service, and the pin is not trusted', () => {
  const { mode, trustChecked } = resolve({ container: 'detected', files: { [LINUX_PIN]: pinText() } });
  assert.deepEqual(mode, { mode: 'required_unavailable', reason: 'container_unverified' });
  assert.equal(trustChecked, false, 'the container rule runs before any pin trust is evaluated');
});

test('a container with no pin is required_unavailable, never legacy', () => {
  assert.deepEqual(resolve({ container: 'detected' }).mode,
    { mode: 'required_unavailable', reason: 'container_unverified' });
});

test('a container with an env-override pin is required_unavailable, never service', () => {
  const { mode } = resolve({ container: 'detected', files: { '/srv/pin.json': pinText() },
    env: { AUTHORITY_PIN_PATH: '/srv/pin.json' } });
  assert.deepEqual(mode, { mode: 'required_unavailable', reason: 'container_unverified' });
});

test('a container probe that cannot decide, or throws, fails closed', () => {
  for (const container of ['unknown', 'garbage', () => { throw new Error('probe broke'); }]) {
    const { mode } = resolve({ container, files: { [LINUX_PIN]: pinText() } });
    assert.deepEqual(mode, { mode: 'required_unavailable', reason: 'container_probe_failed' }, String(container));
  }
});

test('the rule applies on win32 too', () => {
  assert.equal(resolve({ container: 'detected', platform: 'win32' }).mode.reason, 'container_unverified');
});

test('probeContainer: a marker or env marker is detected, nothing is absent, an uninspectable marker is unknown', () => {
  assert.equal(probeContainer({ environment: {}, markerExists: m => m === '/.dockerenv' }), 'detected');
  assert.equal(probeContainer({ environment: { KUBERNETES_SERVICE_HOST: '10.0.0.1' }, markerExists: () => false }), 'detected');
  assert.equal(probeContainer({ environment: {}, markerExists: () => false }), 'absent');
  const denied = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
  assert.equal(probeContainer({ environment: {}, markerExists: denied }), 'unknown');
  assert.equal(probeContainer({ environment: { container: 'podman' }, markerExists: denied }), 'detected');
});
