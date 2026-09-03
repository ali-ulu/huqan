'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  EFFECT_VERIFICATION,
  buildExternalActionAdmissionReceipt,
  buildExternalActionOutcomeReceipt,
} = require('../lib/external-action-receipt');
const { normalizeExternalActionEnvelope } = require('../lib/external-action-envelope');

function envelope(overrides = {}) {
  return normalizeExternalActionEnvelope({
    invocationId: 'inv-effect-1',
    workspaceId: 'default',
    agent: { name: 'codex', version: '1' },
    action: { kind: 'shell', command: 'npm test' },
    ...overrides,
  });
}

function admission(env) {
  return buildExternalActionAdmissionReceipt(env, {
    decision: 'allow',
    reason: 'allowlisted',
    risk: { level: 'low', score: 1 },
    findings: [],
  }, { now: () => '2026-09-03T00:00:00.000Z' });
}

test('a reported success is recorded as reported, not observed', () => {
  // The whole point. `status: executed` means the caller said so; nothing here
  // watched the process. A reader holding only the receipt must be able to see
  // that.
  const env = envelope();
  const receipt = buildExternalActionOutcomeReceipt(env, admission(env),
    { status: 'success', output: 'ok' }, { now: () => '2026-09-03T00:00:01.000Z' });

  assert.equal(receipt.status, 'executed');
  assert.equal(receipt.metadata.effectVerification, EFFECT_VERIFICATION.REPORTED);
  assert.notEqual(receipt.metadata.effectVerification, EFFECT_VERIFICATION.OBSERVED);
});

test('a reported failure is still only reported', () => {
  const env = envelope();
  const receipt = buildExternalActionOutcomeReceipt(env, admission(env),
    { status: 'failed', reason: 'exit 1' }, { now: () => '2026-09-03T00:00:01.000Z' });

  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.metadata.effectVerification, EFFECT_VERIFICATION.REPORTED);
});

test('a blocked action claims no effect verification at all', () => {
  // Blocked means the guard refused before execution, so there is no effect
  // whose verification could be claimed in either direction. `reported` here
  // would assert something about an action that never ran.
  const env = envelope();
  const receipt = buildExternalActionOutcomeReceipt(env, admission(env),
    { status: 'blocked', reason: 'denylisted' }, { now: () => '2026-09-03T00:00:01.000Z' });

  assert.equal(receipt.status, 'blocked');
  assert.equal(receipt.metadata.effectVerification, EFFECT_VERIFICATION.NONE);
});

test('caller-supplied behavioural observation does not upgrade the claim', () => {
  // lib/post-action-monitor.js reads durationMs, sideEffectCount and
  // behavioralObservation off `outcome` -- all supplied by the caller. Its
  // `post_action_behavior_observed` reason names when the reading was taken,
  // not who took it, and must not be mistaken for HUQAN having witnessed
  // anything.
  const env = envelope();
  const receipt = buildExternalActionOutcomeReceipt(env, admission(env), {
    status: 'success',
    durationMs: 1200,
    sideEffectCount: 3,
    behavioralObservation: { filesWritten: 3 },
  }, { now: () => '2026-09-03T00:00:01.000Z' });

  assert.equal(receipt.metadata.effectVerification, EFFECT_VERIFICATION.REPORTED);
});

test('nothing in the tree produces an observed verdict yet', () => {
  // The value exists so a verifier can reject an unknown one rather than treat
  // it as equivalent to `reported`. When a real sensor lands, this test is the
  // one that should fail and be rewritten -- not quietly deleted.
  const values = Object.values(EFFECT_VERIFICATION);
  assert.deepEqual(values.sort(), ['none', 'observed', 'reported'].sort());

  const env = envelope();
  for (const status of ['success', 'failed', 'blocked']) {
    const receipt = buildExternalActionOutcomeReceipt(env, admission(env), { status },
      { now: () => '2026-09-03T00:00:01.000Z' });
    assert.notEqual(receipt.metadata.effectVerification, EFFECT_VERIFICATION.OBSERVED);
  }
});

test('the field rides in metadata, so the canonical top level is unchanged', () => {
  // A new top-level key is a schema version -- the way trustRoot was for v2 --
  // and would change the hash of every receipt and every chain over them.
  const env = envelope();
  const receipt = buildExternalActionOutcomeReceipt(env, admission(env),
    { status: 'success' }, { now: () => '2026-09-03T00:00:01.000Z' });

  assert.equal(receipt.effectVerification, undefined, 'must not appear at the top level');
  assert.equal(receipt.schemaVersion, 'v4-receipt-v1', 'the schema version must not move for this');
  assert.equal(typeof receipt.receiptHash, 'string');
  assert.ok(receipt.receiptHash.length > 0);
});
