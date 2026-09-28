'use strict';

// #3006 — AB13 is the one fail-open surface in the external-action gate stack.
// It was invisible to operators: unconfigured, the gate simply never runs. These
// tests pin the doctor finding that makes the resolved state observable, and
// confirm it never fails doctor -- unconfigured is the documented default, not a
// misconfiguration, and the check exists to inform, not to block.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  UNCONFIGURED_MESSAGE,
  checkUnexpectedEgress,
} = require('../lib/unexpected-egress-doctor');
const { DEFAULT_CHECKERS, CHECK_ORDER, runDoctorChecks } = require('../lib/cli-doctor');

test('unconfigured AB13 is reported, passes, and states the fail-open default', () => {
  const result = checkUnexpectedEgress({ environment: {} });
  assert.equal(result.ok, true);
  assert.equal(result.configured, false);
  assert.equal(result.decision, null);
  assert.equal(result.expectedDestinations, 0);
  assert.match(result.detail, /fail-open default/);
  assert.equal(result.detail, UNCONFIGURED_MESSAGE);
});

test('an enabled AB13 reports its decision and destination count', () => {
  const result = checkUnexpectedEgress({
    environment: {
      HUQAN_EXTERNAL_GUARD_EXPECTED_EGRESS: 'review',
      HUQAN_EXTERNAL_GUARD_EXPECTED_DESTINATIONS: 'github.com, api.example.com',
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.configured, true);
  assert.equal(result.decision, 'review');
  assert.equal(result.expectedDestinations, 2);
  assert.match(result.detail, /configured; decision review/);
});

test('the gate can be enabled as a real empty policy, distinct from unconfigured', () => {
  const result = checkUnexpectedEgress({
    environment: { HUQAN_EXTERNAL_GUARD_EXPECTED_EGRESS: 'block' },
  });
  assert.equal(result.configured, true);
  assert.equal(result.decision, 'block');
  assert.equal(result.expectedDestinations, 0);
});

test('doctor registers the egress check and it never fails the run', async () => {
  assert.ok(CHECK_ORDER.some(([key]) => key === 'egress'), 'egress must be in CHECK_ORDER');
  assert.equal(typeof DEFAULT_CHECKERS.egress, 'function');

  const result = await runDoctorChecks(
    { environment: {} },
    { checkers: { egress: () => checkUnexpectedEgress({ environment: {} }) } },
  );
  assert.equal(result.checks.egress.ok, true);
  assert.match(result.checks.egress.detail, /fail-open default/);
});
