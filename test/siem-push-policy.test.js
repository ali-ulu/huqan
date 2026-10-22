'use strict';

// #4093 PR-B4, INV-B6: a push destination is judged once, before any sink is
// built, by the gates the guard already runs on agent egress -- AB12 data
// residency and AB13 expected egress. A `block` from either means the export
// never opens a connection. The SIEM event stream is about actions on citizen
// data, so a declared residency is treated as binding on the SIEM host itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SIEM_PUSH_ERRORS, assertPushDestinationAllowed } = require('../lib/siem/siem-push-policy');

const NO_EXPECTED_EGRESS = {};

test('with nothing declared a push destination is allowed and says why', () => {
  const verdict = assertPushDestinationAllowed({ host: 'siem.example.com', dataResidency: null, environment: NO_EXPECTED_EGRESS });
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.residency.reason, 'data_residency_not_configured');
  assert.equal(verdict.expectedEgress, null);
  assert.deepEqual(verdict.warnings, []);
});

test('refuses endpoint blocked by data residency', () => {
  const dataResidency = { allowedDestinations: ['example.com.tr'] };
  assert.throws(
    () => assertPushDestinationAllowed({ host: 'siem.example.com', dataResidency, environment: NO_EXPECTED_EGRESS }),
    (error) => error.code === SIEM_PUSH_ERRORS.BLOCKED && /data_residency_violation/.test(error.message),
  );
  const inside = assertPushDestinationAllowed({ host: 'siem.example.com.tr', dataResidency, environment: NO_EXPECTED_EGRESS });
  assert.equal(inside.allowed, true);
  assert.equal(inside.residency.reason, 'data_residency_within_boundary');
});

test('refuses endpoint blocked by unexpected egress', () => {
  const environment = {
    HUQAN_EXTERNAL_GUARD_EXPECTED_EGRESS: 'block',
    HUQAN_EXTERNAL_GUARD_EXPECTED_DESTINATIONS: 'api.github.com',
  };
  assert.throws(
    () => assertPushDestinationAllowed({ host: 'siem.example.com', dataResidency: null, environment }),
    (error) => error.code === SIEM_PUSH_ERRORS.BLOCKED && /unexpected/.test(error.message),
  );
  const declared = assertPushDestinationAllowed({
    host: 'siem.example.com',
    dataResidency: null,
    environment: { ...environment, HUQAN_EXTERNAL_GUARD_EXPECTED_DESTINATIONS: 'api.github.com,siem.example.com' },
  });
  assert.equal(declared.allowed, true);
});

test('an unexpected destination in review mode is refused unless the operator accepts it', () => {
  const environment = { HUQAN_EXTERNAL_GUARD_EXPECTED_EGRESS: 'review', HUQAN_EXTERNAL_GUARD_EXPECTED_DESTINATIONS: '' };
  // In the guard, review means a human decides; an unattended export has none.
  assert.throws(
    () => assertPushDestinationAllowed({ host: 'siem.example.com', dataResidency: null, environment }),
    (error) => error.code === SIEM_PUSH_ERRORS.BLOCKED && /allow-unreviewed-host/.test(error.message),
  );
  const accepted = assertPushDestinationAllowed({ host: 'siem.example.com', dataResidency: null, environment, allowReview: true });
  assert.equal(accepted.allowed, true);
  assert.equal(accepted.expectedEgress.decision, 'review');
  assert.equal(accepted.warnings.length, 1);
  assert.ok(accepted.warnings[0].startsWith('SIEM host siem.example.com '), accepted.warnings[0]);
});

test('allowReview never relaxes a block', () => {
  assert.throws(() => assertPushDestinationAllowed({
    host: 'siem.example.com',
    dataResidency: null,
    allowReview: true,
    environment: { HUQAN_EXTERNAL_GUARD_EXPECTED_EGRESS: 'block', HUQAN_EXTERNAL_GUARD_EXPECTED_DESTINATIONS: '' },
  }), { code: SIEM_PUSH_ERRORS.BLOCKED });
});

test('a policy file named explicitly but missing refuses instead of turning residency off', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-siem-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.throws(
    () => assertPushDestinationAllowed({ host: 'siem.example.com', policyPath: path.join(dir, 'typo.json'), environment: NO_EXPECTED_EGRESS }),
    (error) => error.code === SIEM_PUSH_ERRORS.BLOCKED && /does not exist/.test(error.message),
  );
});

test('an IPv6 host is judged whether or not it carries brackets', () => {
  const dataResidency = { allowedDestinations: ['example.com.tr'] };
  for (const host of ['[2001:db8::1]', '2001:db8::1']) {
    assert.throws(
      () => assertPushDestinationAllowed({ host, dataResidency, environment: NO_EXPECTED_EGRESS }),
      (error) => /data_residency_violation/.test(error.message),
      host,
    );
  }
});

test('reads the declared residency from the deployment policy file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-siem-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const policyPath = path.join(dir, 'policy.json');
  fs.writeFileSync(policyPath, JSON.stringify({ dataResidency: { allowedDestinations: ['example.com.tr'] } }));
  assert.throws(
    () => assertPushDestinationAllowed({ host: 'siem.example.com', policyPath, environment: NO_EXPECTED_EGRESS }),
    { code: SIEM_PUSH_ERRORS.BLOCKED },
  );
});

test('refuses an empty host rather than judging nothing', () => {
  assert.throws(() => assertPushDestinationAllowed({ host: '', dataResidency: null, environment: NO_EXPECTED_EGRESS }), { code: SIEM_PUSH_ERRORS.BLOCKED });
});
