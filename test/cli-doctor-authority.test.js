'use strict';

// The doctor's `authority` finding (#4082, ADR-020 section 9) and the
// `escalation` field it carries. Legacy is the documented default and must never
// fail the run; the failures are the states where the boundary is claimed and
// does not hold. The status report is exercised here too, since the checker is
// its consumer and both answer from the same resolution.

const test = require('node:test');
const assert = require('node:assert/strict');

const { CHECK_ORDER, DEFAULT_CHECKERS, runDoctorChecks } = require('../lib/cli-doctor');
const { status, checkAuthority, detectEscalation } = require('../lib/authority/authority-status');

const PIN = Object.freeze({ port: 47821, keyId: 'abcdef0123456789' });

const legacy = () => ({ resolveMode: () => ({ mode: 'legacy', boundary: 'same-user' }),
  resolveAgentBoundary: () => ({ value: 'same-user' }), detectEscalation: () => 'none' });

test('the authority check is registered in CHECK_ORDER and DEFAULT_CHECKERS', () => {
  assert.ok(CHECK_ORDER.some(([key]) => key === 'authority'), 'authority must be in CHECK_ORDER');
  assert.equal(typeof DEFAULT_CHECKERS.authority, 'function');
});

test('legacy is reported, not failed', async () => {
  const result = await checkAuthority(legacy());
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'legacy');
  assert.match(result.detail, /protected only by the same OS user/);
});

test('required_unavailable fails with its reason', async () => {
  const result = await checkAuthority({ resolveMode: () => ({ mode: 'required_unavailable', reason: 'pin_malformed', pinPath: 'pin' }),
    resolveAgentBoundary: () => ({ value: 'same-user' }), detectEscalation: () => 'none' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'pin_malformed');
  assert.match(result.detail, /required but unavailable \(pin_malformed\)/);
});

test('a service that does not answer fails', async () => {
  const result = await checkAuthority({
    resolveMode: () => ({ mode: 'service', boundary: 'os-service', pinPath: 'pin', pin: PIN }),
    resolveAgentBoundary: () => ({ value: 'same-user' }), detectEscalation: () => 'none',
    createClient: () => ({ identity: async () => { throw Object.assign(new Error('down'), { code: 'AUTHORITY_UNAVAILABLE' }); } }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.answering, false);
  assert.equal(result.error, 'AUTHORITY_UNAVAILABLE');
});

test('passwordless sudo is reported as escalation and fails the os-service claim', async () => {
  const deps = {
    resolveMode: () => ({ mode: 'service', boundary: 'os-service', pinPath: 'pin', pin: PIN }),
    resolveAgentBoundary: () => ({ value: 'same-user' }), detectEscalation: () => 'passwordless_sudo',
    createClient: () => ({ identity: async () => ({ status: 200, body: { keyId: PIN.keyId } }) }),
  };
  const result = await checkAuthority(deps);
  assert.equal(result.ok, false);
  assert.equal(result.escalation, 'passwordless_sudo');
  assert.match(result.detail, /os-service boundary does not hold/);
});

test('passwordless sudo does not fail an env-override pin, which claims no OS boundary', async () => {
  const result = await checkAuthority({
    resolveMode: () => ({ mode: 'service', boundary: 'env-override', pinPath: 'pin', pin: PIN }),
    resolveAgentBoundary: () => ({ value: 'same-user' }), detectEscalation: () => 'passwordless_sudo',
    createClient: () => ({ identity: async () => ({ status: 200, body: { keyId: PIN.keyId } }) }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.boundary, 'env-override');
  assert.equal(result.escalation, 'passwordless_sudo');
  assert.match(result.detail, /password prompt/);
});

test('an inconclusive probe passes but does not claim escalation is impossible', async () => {
  const result = await checkAuthority({
    resolveMode: () => ({ mode: 'service', boundary: 'os-service', pinPath: 'pin', pin: PIN }),
    resolveAgentBoundary: () => ({ value: 'os-user' }), detectEscalation: () => 'unknown',
    createClient: () => ({ identity: async () => ({ status: 200, body: { keyId: PIN.keyId } }) }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.escalation, 'unknown');
  assert.match(result.detail, /could not run, so escalation is unverified/);
});

test('a service that answers with no escalation passes', async () => {
  const result = await checkAuthority({
    resolveMode: () => ({ mode: 'service', boundary: 'os-service', pinPath: 'pin', pin: PIN }),
    resolveAgentBoundary: () => ({ value: 'os-user' }), detectEscalation: () => 'none',
    createClient: () => ({ identity: async () => ({ status: 200, body: { keyId: PIN.keyId } }) }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.answering, true);
  assert.equal(result.escalation, 'none');
});

test('the doctor aggregation carries the authority check alongside the others', async () => {
  const result = await runDoctorChecks({}, {
    checkers: { authority: () => checkAuthority(legacy()) },
  });
  assert.equal(result.checks.authority.ok, true);
  assert.equal(result.checks.authority.mode, 'legacy');
});

test('status carries escalation on posix, in every mode', async () => {
  const reported = await status({ resolveMode: () => ({ mode: 'legacy', boundary: 'same-user' }),
    resolveAgentBoundary: () => ({ value: 'same-user' }), detectEscalation: () => 'passwordless_sudo' });
  assert.equal(reported.report.escalation, 'passwordless_sudo');

  const unavailable = await status({ resolveMode: () => ({ mode: 'required_unavailable', reason: 'pin_malformed', pinPath: 'pin' }),
    resolveAgentBoundary: () => ({ value: 'same-user' }), detectEscalation: () => 'none' });
  assert.equal(unavailable.report.escalation, 'none');
});

test('the escalation probe is non-interactive, fixed and fails closed to unknown', () => {
  const calls = [];
  const run = (cmd, args, opts) => { calls.push([cmd, args, opts]); return { status: 0 }; };
  assert.equal(detectEscalation({ platform: 'linux', run }), 'passwordless_sudo');
  assert.deepEqual(calls[0][0], 'sudo');
  assert.deepEqual(calls[0][1], ['-n', 'true'], 'the probe must not prompt for a password');
  assert.equal(detectEscalation({ platform: 'darwin', run: () => ({ status: 1 }) }), 'none');
  // A probe that cannot run is not a pass: "no sudo" and "could not tell" differ.
  assert.equal(detectEscalation({ platform: 'linux', run: () => ({ error: new Error('ENOENT') }) }), 'unknown');
  assert.equal(detectEscalation({ platform: 'linux', run: () => ({ status: null }) }), 'unknown');
  assert.equal(detectEscalation({ platform: 'win32', run: () => { throw new Error('must not run'); } }), 'not_applicable');
});
