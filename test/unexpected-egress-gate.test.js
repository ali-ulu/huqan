'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AB13_GATE_VERSION,
  UNEXPECTED_EGRESS_DECISIONS,
  UNEXPECTED_EGRESS_REASONS,
  expectedEgressOptions,
  evaluateUnexpectedEgress,
} = require('../lib/unexpected-egress-gate');

const EXPECTED = ['api.internal.example', 'github.com'];

function evaluate(destinations, overrides = {}) {
  return evaluateUnexpectedEgress({
    destinations,
    expected: EXPECTED,
    decision: UNEXPECTED_EGRESS_DECISIONS.REVIEW,
    ...overrides,
  });
}

test('an action with no destination at all is allowed', () => {
  const result = evaluate([]);

  assert.equal(result.decision, UNEXPECTED_EGRESS_DECISIONS.ALLOW);
  assert.equal(result.reason, UNEXPECTED_EGRESS_REASONS.NO_DESTINATION);
  assert.deepEqual(result.unexpectedDestinations, []);
  assert.equal(result.gateVersion, AB13_GATE_VERSION);
});

test('a declared destination is allowed', () => {
  const result = evaluate(['github.com']);

  assert.equal(result.decision, UNEXPECTED_EGRESS_DECISIONS.ALLOW);
  assert.equal(result.reason, UNEXPECTED_EGRESS_REASONS.ALL_EXPECTED);
});

test('a subdomain of a declared destination is allowed', () => {
  const result = evaluate(['api.github.com']);

  assert.equal(result.decision, UNEXPECTED_EGRESS_DECISIONS.ALLOW);
});

test('a destination nobody declared is flagged', () => {
  const result = evaluate(['exfil.example.net']);

  assert.equal(result.decision, UNEXPECTED_EGRESS_DECISIONS.REVIEW);
  assert.equal(result.reason, UNEXPECTED_EGRESS_REASONS.UNEXPECTED);
  assert.deepEqual(result.unexpectedDestinations, ['exfil.example.net']);
});

test('the gate fires on an unexpected destination that carries no PII at all', () => {
  // This is the whole point of AB13: AB12 only speaks when citizen data is in
  // the payload, so an unexpected destination carrying nothing sensitive used
  // to pass in silence.
  const result = evaluate(['exfil.example.net'], { piiDetected: false });

  assert.equal(result.decision, UNEXPECTED_EGRESS_DECISIONS.REVIEW);
  assert.equal(result.reason, UNEXPECTED_EGRESS_REASONS.UNEXPECTED);
});

test('only the undeclared destinations are reported, not the whole set', () => {
  const result = evaluate(['github.com', 'exfil.example.net', 'api.internal.example']);

  assert.deepEqual(result.unexpectedDestinations, ['exfil.example.net']);
});

test('loopback is never treated as external egress', () => {
  const result = evaluate(['localhost', '127.0.0.1']);

  assert.equal(result.decision, UNEXPECTED_EGRESS_DECISIONS.ALLOW);
  // Not merely allowed: a loopback-only action left nothing at all, so it must
  // read as "no destination" rather than "every destination was on the list".
  // A reader mining these reasons for real egress would otherwise count it.
  assert.equal(result.reason, UNEXPECTED_EGRESS_REASONS.NO_DESTINATION);
});

test('the configured verdict is honoured when a deployment wants it fatal', () => {
  const result = evaluate(['exfil.example.net'], { decision: UNEXPECTED_EGRESS_DECISIONS.BLOCK });

  assert.equal(result.decision, UNEXPECTED_EGRESS_DECISIONS.BLOCK);
});

test('a destination that could not be parsed is flagged rather than assumed safe', () => {
  const result = evaluate([], { unparseable: true });

  assert.equal(result.decision, UNEXPECTED_EGRESS_DECISIONS.REVIEW);
  assert.equal(result.reason, UNEXPECTED_EGRESS_REASONS.UNREADABLE_DESTINATION);
});

test('host comparison is case-insensitive', () => {
  const result = evaluate(['API.GitHub.com']);

  assert.equal(result.decision, UNEXPECTED_EGRESS_DECISIONS.ALLOW);
});

test('an empty expected list flags every external destination', () => {
  const result = evaluate(['github.com'], { expected: [] });

  assert.equal(result.decision, UNEXPECTED_EGRESS_DECISIONS.REVIEW);
  assert.deepEqual(result.unexpectedDestinations, ['github.com']);
});

test('expectedEgressOptions is null unless the deployment opts in', () => {
  assert.equal(expectedEgressOptions({ environment: {} }), null);
  assert.equal(expectedEgressOptions({ expectedEgress: { enabled: false }, environment: {} }), null);
});

test('expectedEgressOptions reads the declared destinations and defaults to review', () => {
  const config = expectedEgressOptions({
    expectedEgress: { enabled: true, destinations: ['Github.com', ' api.internal.example '] },
    environment: {},
  });

  assert.deepEqual(config.expected, ['github.com', 'api.internal.example'], 'normalized and lowercased');
  assert.equal(config.decision, UNEXPECTED_EGRESS_DECISIONS.REVIEW);
});

test('expectedEgressOptions can be opted into from the environment', () => {
  const config = expectedEgressOptions({
    environment: {
      HUQAN_EXTERNAL_GUARD_EXPECTED_EGRESS: 'block',
      HUQAN_EXTERNAL_GUARD_EXPECTED_DESTINATIONS: 'github.com, api.internal.example',
    },
  });

  assert.equal(config.decision, UNEXPECTED_EGRESS_DECISIONS.BLOCK);
  assert.deepEqual(config.expected, ['github.com', 'api.internal.example']);
});

test('opting in with no declared destination is a refusal to configure, not a silent allow-all', () => {
  // An empty allowlist is a meaningful policy ("nothing may leave"), so it must
  // not be confused with "not configured". Enabling with no list keeps the gate
  // on, and every external destination reads as unexpected.
  const config = expectedEgressOptions({ expectedEgress: { enabled: true }, environment: {} });

  assert.ok(config, 'enabled means enabled');
  assert.deepEqual(config.expected, []);
});
