'use strict';

/**
 * Contract for the mandatory mutation admission seam (P1).
 *
 * The seam performs no identity checks yet, so the property under test is not
 * "does it reject bad claims" but the two things the later controls depend on
 * and cannot establish for themselves:
 *
 *   1. a mutation cannot run unless the context is complete and well-formed;
 *   2. the evaluation clock is receiver-owned.
 *
 * The tests are written so that switching enforcement on later changes what is
 * admitted, not whether `mutate` can be reached without admission.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ADMISSION_ERRORS,
  CONTEXT_FIELDS,
  absent,
  createMutationAdmission,
  isAbsent,
} = require('../lib/mutation-admission.js');

const FIXED_CLOCK = () => new Date('2026-08-16T12:00:00.000Z');

function completeContext(overrides = {}) {
  return {
    workspaceId: 'default',
    action: 'graph.addNode',
    identityClaim: absent('no caller carries an identity claim yet'),
    delegationContext: absent('delegation is not modelled at this caller'),
    connectorContext: absent('not reached through a connector'),
    ...overrides,
  };
}

test('admission: a complete context admits, and the mutation runs once', () => {
  const admission = createMutationAdmission({ clock: FIXED_CLOCK });
  let calls = 0;

  const outcome = admission.admit(completeContext(), () => { calls += 1; return 'written'; });

  assert.equal(outcome.admitted, true);
  assert.equal(outcome.result, 'written');
  assert.equal(calls, 1);
});

test('admission: an incomplete context refuses and never reaches the mutation', () => {
  const admission = createMutationAdmission({ clock: FIXED_CLOCK });

  for (const field of CONTEXT_FIELDS) {
    const context = completeContext();
    delete context[field];
    let called = false;

    const outcome = admission.admit(context, () => { called = true; });

    assert.equal(outcome.admitted, false, `${field} missing must refuse`);
    assert.equal(outcome.reason, ADMISSION_ERRORS.CONTEXT_INCOMPLETE);
    assert.match(outcome.detail, new RegExp(field));
    // The property that makes this a boundary rather than a log line.
    assert.equal(called, false, `${field} missing must not reach the mutation`);
  }
});

test('admission: present-but-empty is refused, not read as absent', () => {
  const admission = createMutationAdmission({ clock: FIXED_CLOCK });

  for (const [field, value] of [
    ['workspaceId', ''],
    ['workspaceId', '   '],
    ['action', ''],
    ['identityClaim', null],
    ['identityClaim', 'anonymous'],
    ['delegationContext', []],
    ['connectorContext', 0],
  ]) {
    let called = false;
    const outcome = admission.admit(completeContext({ [field]: value }), () => { called = true; });

    // Treating an empty value as "no identity" is how an enforcement gap
    // becomes invisible: it would pass today and read as intentional later.
    assert.equal(outcome.admitted, false, `${field}=${JSON.stringify(value)} must refuse`);
    assert.equal(outcome.reason, ADMISSION_ERRORS.CONTEXT_INVALID);
    assert.equal(outcome.detail, field);
    assert.equal(called, false);
  }
});

test('admission: a declared absence is accepted and carries its reason', () => {
  const marker = absent('no caller carries an identity claim yet');

  assert.equal(isAbsent(marker), true);
  assert.equal(marker.reason, 'no caller carries an identity claim yet');

  // An unexplained absence is indistinguishable from an oversight, which is the
  // one thing this marker exists to prevent.
  assert.throws(() => absent(''), /requires a reason/);
  assert.throws(() => absent('   '), /requires a reason/);
  assert.throws(() => absent(undefined), /requires a reason/);
});

test('admission: the caller cannot supply the evaluation clock', () => {
  const admission = createMutationAdmission({ clock: FIXED_CLOCK });
  let called = false;

  const outcome = admission.admit(
    completeContext({ evaluationTime: '2020-01-01T00:00:00.000Z' }),
    () => { called = true; },
  );

  // Refused rather than ignored: silently overwriting it would hide an attempt
  // to control expiry, and expiry is one of the controls this context exists to
  // make decidable.
  assert.equal(outcome.admitted, false);
  assert.equal(outcome.reason, ADMISSION_ERRORS.CALLER_SUPPLIED_CLOCK);
  assert.equal(called, false);
});

test('admission: the evaluation time is stamped by the receiver', () => {
  const admission = createMutationAdmission({ clock: FIXED_CLOCK });
  const outcome = admission.admit(completeContext(), () => null);

  assert.equal(outcome.evaluationTime, '2026-08-16T12:00:00.000Z');
});

test('admission: a malformed call refuses before anything runs', () => {
  const admission = createMutationAdmission({ clock: FIXED_CLOCK });

  for (const context of [null, undefined, 'ctx', 42, []]) {
    const outcome = admission.admit(context, () => { throw new Error('must not run'); });
    assert.equal(outcome.admitted, false);
    assert.equal(outcome.reason, ADMISSION_ERRORS.CONTEXT_MISSING);
  }

  const missingMutation = admission.admit(completeContext(), 'not-a-function');
  assert.equal(missingMutation.admitted, false);
  assert.equal(missingMutation.reason, ADMISSION_ERRORS.MUTATION_INVALID);
});

test('admission: a refusal is returned, not thrown', () => {
  const admission = createMutationAdmission({ clock: FIXED_CLOCK });

  // A thrown refusal could be swallowed by a caller's own try/catch and read as
  // an unrelated failure, which is how a boundary silently stops boundng.
  assert.doesNotThrow(() => {
    const outcome = admission.admit({}, () => null);
    assert.equal(outcome.admitted, false);
  });
});

test('admission: durability stays the mutation\'s own concern', () => {
  const admission = createMutationAdmission({ clock: FIXED_CLOCK });
  const source = require('node:fs').readFileSync(require.resolve('../lib/mutation-admission.js'), 'utf8');

  // Invariant 1: admission is not durability. If this module ever calls
  // runMutationOnce, the two responsibilities have been fused and receipt and
  // retry semantics become tied to identity semantics.
  assert.ok(!/runMutationOnce\s*\(/.test(source), 'the seam must not call runMutationOnce');

  // Whatever the caller did for durability still happens, untouched.
  let durableRan = false;
  const outcome = admission.admit(completeContext(), () => {
    durableRan = true;
    return { committed: true };
  });

  assert.equal(durableRan, true);
  assert.deepEqual(outcome.result, { committed: true });
});

test('admission: a forged absent marker without a real reason fails closed (#879)', () => {
  const admission = createMutationAdmission({ clock: FIXED_CLOCK });

  for (const marker of [
    { kind: 'absent' },
    { kind: 'absent', reason: '   ' },
    { kind: 'absent', reason: '' },
    { kind: 'absent', reason: 42 },
    { kind: 'absent', extra: 'x' },
  ]) {
    for (const field of ['identityClaim', 'delegationContext', 'connectorContext']) {
      let called = false;
      const context = completeContext({ [field]: marker });
      const outcome = admission.admit(context, () => { called = true; });

      // The marker impersonates `absent(reason)` but skips the helper, so the
      // invariant it exists to close — an unexplained absence — is present.
      // It must not fall back to the "plain object claim" branch.
      assert.equal(outcome.admitted, false, `forged marker on ${field} must refuse`);
      assert.equal(outcome.reason, ADMISSION_ERRORS.CONTEXT_INVALID);
      assert.equal(outcome.detail, field);
      assert.equal(called, false, `forged marker on ${field} must not reach the mutation`);
    }
  }

  // A real object claim is still accepted; it simply may not carry the absent
  // kind. Impersonation is refused; ownership is not.
  let claimedCalled = false;
  const ownedOutcome = admission.admit(
    completeContext({ identityClaim: { kind: 'identity', ref: 'r1' } }),
    () => { claimedCalled = true; },
  );
  assert.equal(ownedOutcome.admitted, true);
  assert.equal(claimedCalled, true);
});

test('isAbsent: the marker schema is verified, not just the kind (#879)', () => {
  assert.equal(isAbsent({ kind: 'absent' }), false);
  assert.equal(isAbsent({ kind: 'absent', reason: '   ' }), false);
  assert.equal(isAbsent({ kind: 'absent', reason: '' }), false);
  assert.equal(isAbsent(Object.create(null)), false);
  assert.equal(isAbsent(null), false);
  assert.equal(isAbsent([]), false);
  assert.equal(isAbsent(absent('a reason')), true);
});


test('admission: configured identity evaluator refuses before mutation and preserves reason', () => {
  let evaluatorCalls = 0;
  const admission = createMutationAdmission({
    clock: FIXED_CLOCK,
    identityEvaluator: (context) => {
      evaluatorCalls += 1;
      assert.equal(context.evaluationTime, '2026-08-16T12:00:00.000Z');
      return { decision: 'block', allowed: false, reason: 'identity.workspace_mismatch' };
    },
  });
  let mutationCalls = 0;

  const outcome = admission.admit(
    completeContext({ identityClaim: { kind: 'identity', ref: 'r1' } }),
    () => { mutationCalls += 1; },
  );

  assert.equal(outcome.admitted, false);
  assert.equal(outcome.reason, ADMISSION_ERRORS.IDENTITY_REFUSED);
  assert.equal(outcome.detail, 'identity.workspace_mismatch');
  assert.equal(evaluatorCalls, 1);
  assert.equal(mutationCalls, 0);
});

test('admission: configured identity evaluator must explicitly allow before mutation', () => {
  let received;
  const admission = createMutationAdmission({
    clock: FIXED_CLOCK,
    identityEvaluator: (context) => {
      received = context;
      return { decision: 'allow', allowed: true, reason: 'ok' };
    },
  });

  const outcome = admission.admit(
    completeContext({ identityClaim: { kind: 'identity', ref: 'r1' } }),
    () => 'written',
  );

  assert.equal(outcome.admitted, true);
  assert.equal(outcome.result, 'written');
  assert.equal(received.evaluationTime, '2026-08-16T12:00:00.000Z');
  assert.equal(received.workspaceId, 'default');
});

test('admission: evaluator failure fails closed and never reaches mutation', () => {
  const admission = createMutationAdmission({
    clock: FIXED_CLOCK,
    identityEvaluator: () => { throw new Error('unexpected evaluator failure'); },
  });
  let called = false;

  const outcome = admission.admit(
    completeContext({ identityClaim: { kind: 'identity', ref: 'r1' } }),
    () => { called = true; },
  );

  assert.equal(outcome.admitted, false);
  assert.equal(outcome.reason, ADMISSION_ERRORS.IDENTITY_EVALUATOR_INVALID);
  assert.equal(called, false);
});

test('admission: identity evaluator configuration rejects non-functions', () => {
  assert.throws(
    () => createMutationAdmission({ identityEvaluator: 'not-a-function' }),
    /admission\.identity_evaluator_invalid/,
  );
});
