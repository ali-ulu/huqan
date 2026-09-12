'use strict';

/**
 * The learn-admission decision, including the branch that had no test.
 *
 * `kernel.js` writes to the graph only when the admission outcome is `allow`.
 * When the memory-admission evaluator returns nothing usable, this module is
 * supposed to answer `review` -- fail closed -- so an unreadable verdict
 * blocks the write. Changing that branch to `allow` passed the entire suite,
 * so the rule was stated in code and checked nowhere.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateLearnAdmission } = require('../lib/kernel-learn-admission');

function deps(overrides = {}) {
  return {
    kernel: { plugins: { emit: () => {} } },
    isLearnAdmissionBypass: () => false,
    contractVersion: 'test-contract',
    ...overrides,
  };
}

const UNUSABLE = [
  ['nothing at all', () => null],
  ['undefined', () => undefined],
  ['a not-ok envelope', () => ({ ok: false, decision: { decision: 'allow', allowed: true } })],
  ['an envelope with no decision', () => ({ ok: true })],
  ['an envelope whose decision is null', () => ({ ok: true, decision: null })],
];

for (const [label, evaluate] of UNUSABLE) {
  test(`an evaluator returning ${label} blocks the write rather than permitting it`, () => {
    const result = evaluateLearnAdmission(deps({ evaluate }), 'a cat is an animal');

    assert.notEqual(result.outcome, 'allow', 'an unreadable verdict must never read as allow');
    assert.equal(result.outcome, 'review');
    assert.equal(result.reason, 'memory_admission_evaluation_failed');
    assert.equal(result.graphWrite, false);
  });
}

test('an evaluator that throws is not caught here, so the failure is not silently an allow', () => {
  assert.throws(
    () => evaluateLearnAdmission(deps({ evaluate: () => { throw new Error('gate down'); } }), 'a cat is an animal'),
    /gate down/,
  );
});

test('a usable verdict is passed through as the gate decided it', () => {
  const decision = {
    decision: 'reject',
    reason: 'policy',
    allowed: false,
    approvalStatus: 'none',
    provenanceId: 'prov-1',
    receiptId: 'rec-1',
    receipt: { id: 'rec-1' },
    trustPolicyVersion: 'v1',
  };

  const result = evaluateLearnAdmission(deps({ evaluate: () => ({ ok: true, decision }) }), 'a cat is an animal');

  assert.equal(result.outcome, 'reject');
  assert.equal(result.reason, 'policy');
  assert.equal(result.graphWrite, false);
  assert.equal(result.receiptId, 'rec-1');
  assert.equal(result.trustPolicyVersion, 'v1');
});

test('an allowed verdict reports the write the gate permitted', () => {
  const result = evaluateLearnAdmission(
    deps({ evaluate: () => ({ ok: true, decision: { decision: 'allow', reason: 'ok', allowed: true } }) }),
    'a cat is an animal',
  );

  assert.equal(result.outcome, 'allow');
  assert.equal(result.graphWrite, true);
});

test('a bypass short-circuits before the evaluator is consulted', () => {
  let consulted = false;
  const result = evaluateLearnAdmission(
    deps({ isLearnAdmissionBypass: () => true, evaluate: () => { consulted = true; return null; } }),
    'a cat is an animal',
  );

  assert.equal(result, null);
  assert.equal(consulted, false);
});

test('the workspace the caller asked about is the one reported back', () => {
  const result = evaluateLearnAdmission(deps({ evaluate: () => null }), 'x', {}, null, 'tenant-b');

  assert.equal(result.workspaceId, 'tenant-b');
});
