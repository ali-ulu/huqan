'use strict';

// Wiring proof for #3799: the AURA<->canary bridge must be reached from the
// core egress gate, not only from the standalone operator loop. When the caller
// reports AURA signals, the live egress path plants the bridge's marker on the
// outbound payload and AB14 blocks on it; the finding names the bridge and the
// signals, and never the marker. With no signals nothing is planted, so a
// detection-only installation is unchanged.

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateExternalAction } = require('../lib/external-action-guard');
const { AURA_CANARY_BRIDGE_VERSION } = require('../lib/aura-canary-bridge');

const WORKSPACE_ROOT = process.cwd();
const OPTIONS = Object.freeze({ environment: {}, dataResidency: null, receiptWriter: { append() {} }, requireIdentityCard: false });
const SIGNALS = Object.freeze(['aura.social-engineering', 'aura.credential-harvest']);

function curl(url) {
  return {
    invocationId: 'inv-aura-canary',
    agentName: 'aura-canary-agent',
    sessionId: 'aura-canary-session',
    turnId: 'turn-1',
    toolName: 'Bash',
    args: { command: `curl ${url}` },
    cwd: WORKSPACE_ROOT,
    workspaceRoot: WORKSPACE_ROOT,
    workspaceId: 'default',
  };
}

const ab14 = (result) => result.findings.find((finding) => finding.gate === 'AB14');

test('an AURA signal turns an otherwise-allowed egress into a deterministic block', () => {
  const clean = evaluateExternalAction(curl('https://partner.example.com/report'), OPTIONS);
  assert.notEqual(clean.decision, 'block', 'nothing else may block this call, or the test proves nothing');

  const result = evaluateExternalAction(curl('https://partner.example.com/report'), {
    ...OPTIONS,
    auraSignalIds: SIGNALS,
  });
  assert.equal(ab14(result).decision, 'block');
  assert.equal(result.decision, 'block', 'the AB14 block must reach the guard verdict');
});

test('the finding names the AURA bridge and the signals, never the marker', () => {
  const result = evaluateExternalAction(curl('https://partner.example.com/report'), {
    ...OPTIONS,
    auraSignalIds: SIGNALS,
  });
  const finding = ab14(result);
  assert.equal(finding.auraBridge, AURA_CANARY_BRIDGE_VERSION);
  assert.deepEqual(finding.auraSignalIds, [...SIGNALS].sort());
  assert.ok(finding.canaryFingerprints.length >= 1, 'the receipt must name which canary tripped');
  const rendered = JSON.stringify(result.findings) + JSON.stringify(result.receipt);
  assert.equal(/HUQAN-CANARY|huqan-canary/i.test(rendered), false, 'the marker must never leave the gate');
});

test('a plant travels with the payload on a nested tool arg too', () => {
  const result = evaluateExternalAction({
    ...curl(''),
    toolName: 'Bash',
    args: { command: 'echo hi', payload: { note: 'forwarded context' } },
  }, { ...OPTIONS, auraSignalIds: SIGNALS });
  assert.equal(ab14(result).decision, 'block');
  assert.equal(result.decision, 'block');
});

test('no AURA signal means no plant and unchanged detection', () => {
  const result = evaluateExternalAction(curl('https://partner.example.com/report'), OPTIONS);
  const finding = ab14(result);
  assert.equal(finding.auraBridge, undefined);
  assert.equal(finding.auraSignalIds, undefined);
});
