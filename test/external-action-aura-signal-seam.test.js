'use strict';

// #3802: the AURA signal -> egress seam. The egress gate plants a context
// canary only when `options.auraSignalIds` is set, and nothing set it, so an
// AURA verdict could never be upgraded to a leak proof on the live path. A
// caller that holds a signal source now passes `options.signalProvider`; the
// guard extracts the named signals and forwards them as `auraSignalIds`.
//
// These pin the seam's three rules: the ids plant a canary, a provider's
// *decision* is not merged into the guard verdict, and no provider changes
// nothing.

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateExternalAction } = require('../lib/external-action-guard');
const { gateSignalProviderForKernel } = require('../lib/gate-signal-provider');

// The AURA plugin reports several bounded signal ids in one call. The provider
// used to collapse them into the plugin's generic name, so the seam would have
// planted `aura-risk:signal` instead of the facts the gate actually saw.
function auraKernel() {
  return {
    plugins: {
      plugins: [{
        name: 'aura-risk',
        gateSignal: () => ({
          decision: 'review',
          reason: 'aura_signals:camouflage:naive,recon:targeted',
          riskScore: 87,
          signals: ['camouflage:naive', 'recon:targeted'],
        }),
      }],
    },
  };
}

const WORKSPACE_ROOT = process.cwd();
const OPTIONS = Object.freeze({ environment: {}, dataResidency: null, receiptWriter: { append() {} }, requireIdentityCard: false });

// A shell fetch: nothing else blocks it, so only the AB14 plant can.
function curl(url) {
  return {
    invocationId: 'inv-aura-seam',
    agentName: 'seam-agent',
    sessionId: 'seam-session',
    turnId: 'turn-1',
    toolName: 'Bash',
    args: { command: `curl ${url}` },
    cwd: WORKSPACE_ROOT,
    workspaceRoot: WORKSPACE_ROOT,
    workspaceId: 'default',
  };
}

function providerWith(signal) {
  return () => ({ decision: 'review', reason: `signal:${signal}`, findings: [{ gate: 'SIGNAL', signal, decision: 'review', risk: { score: 80 } }] });
}

test('a provider signal id plants a canary and AB14 blocks', () => {
  const without = evaluateExternalAction(curl('https://github.com/ali-ulu/huqan'), OPTIONS);
  assert.notEqual(without.decision, 'block', 'without a signal nothing blocks this call, or the test proves nothing');

  const result = evaluateExternalAction(curl('https://github.com/ali-ulu/huqan'), {
    ...OPTIONS,
    signalProvider: providerWith('recon:targeted'),
  });
  const ab14 = result.findings.find((finding) => finding.gate === 'AB14');
  assert.equal(ab14.decision, 'block', 'the provider signal must plant a canary that trips AB14');
  assert.equal(result.decision, 'block', 'the AB14 decision must be merged into the guard verdict');
});

test('the planted finding names the AURA signal ids, never the marker', () => {
  const result = evaluateExternalAction(curl('https://github.com/ali-ulu/huqan'), {
    ...OPTIONS,
    signalProvider: providerWith('camouflage:naive'),
  });
  const ab14 = result.findings.find((finding) => finding.gate === 'AB14');
  assert.ok(ab14.auraSignalIds.includes('camouflage:naive'));
  assert.ok(ab14.canaryFingerprints.length >= 1);
  assert.ok(!JSON.stringify(ab14).includes('AURA-CANARY'), 'the marker itself must never reach the receipt');
});

test('a provider decision is not merged into the guard verdict', () => {
  const result = evaluateExternalAction(curl('https://github.com/ali-ulu/huqan'), {
    ...OPTIONS,
    signalProvider: () => ({ decision: 'block', reason: 'signal:block', findings: [] }),
  });
  assert.notEqual(result.decision, 'block', 'with no named signal nothing is planted, so the provider decision must not block here');
});

test('no provider leaves the egress gate exactly as before', () => {
  const result = evaluateExternalAction(curl('https://github.com/ali-ulu/huqan'), OPTIONS);
  const ab14 = result.findings.find((finding) => finding.gate === 'AB14');
  assert.equal(ab14.decision, 'allow');
  assert.deepEqual(ab14.canaryFingerprints, []);
});

test('a provider that throws is inert, not a crash', () => {
  const result = evaluateExternalAction(curl('https://github.com/ali-ulu/huqan'), {
    ...OPTIONS,
    signalProvider: () => { throw new Error('provider exploded'); },
  });
  assert.notEqual(result.decision, 'block');
});

test('caller-supplied auraSignalIds still plant alongside a provider', () => {
  const result = evaluateExternalAction(curl('https://github.com/ali-ulu/huqan'), {
    ...OPTIONS,
    auraSignalIds: ['explicit:signal'],
    signalProvider: providerWith('recon:targeted'),
  });
  const ab14 = result.findings.find((finding) => finding.gate === 'AB14');
  assert.equal(ab14.decision, 'block');
  assert.ok(ab14.auraSignalIds.includes('explicit:signal'));
  assert.ok(ab14.auraSignalIds.includes('recon:targeted'));
});

test('a provider that returns no findings array is inert', () => {
  for (const provided of [undefined, null, 'review', { decision: 'review' }]) {
    const result = evaluateExternalAction(curl('https://github.com/ali-ulu/huqan'), {
      ...OPTIONS,
      signalProvider: () => provided,
    });
    assert.notEqual(result.decision, 'block');
  }
});

test('a SIGNAL finding without a signal id is skipped, not planted as undefined', () => {
  const result = evaluateExternalAction(curl('https://github.com/ali-ulu/huqan'), {
    ...OPTIONS,
    signalProvider: () => ({
      decision: 'review',
      findings: [{ gate: 'SIGNAL', decision: 'review' }, { gate: 'RULE', ruleId: 'r1' }],
    }),
  });
  const ab14 = result.findings.find((finding) => finding.gate === 'AB14');
  assert.deepEqual(ab14.canaryFingerprints, []);
});

test('the kernel-backed provider surfaces every AURA signal id', () => {
  const provider = gateSignalProviderForKernel(auraKernel());
  const verdict = provider({ tool: 'Bash', args: { command: 'curl https://example.com' }, metadata: {} });
  const ids = verdict.findings.filter((f) => f.gate === 'SIGNAL').map((f) => f.signal);
  assert.deepEqual(ids, ['camouflage:naive', 'recon:targeted']);
});

test('an AURA verdict through the kernel provider plants and blocks on egress', () => {
  const result = evaluateExternalAction(curl('https://github.com/ali-ulu/huqan'), {
    ...OPTIONS,
    signalProvider: gateSignalProviderForKernel(auraKernel()),
  });
  const ab14 = result.findings.find((finding) => finding.gate === 'AB14');
  assert.equal(ab14.decision, 'block');
  assert.deepEqual(ab14.auraSignalIds, ['camouflage:naive', 'recon:targeted']);
});
