'use strict';

/**
 * #3500 (R45): bounded reask with a deterministic fix.
 *
 * Hermetic: no I/O, no storage, no timers. The fix is deterministic and the
 * re-validation is the caller's, so the whole module is pure data in and out.
 *
 * The negative cases are the point of this file: a fix must never be applied
 * without surviving re-validation, must never open a policy block, and must
 * never let a correction retry without drawing on the same persisted budget.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createBoundedReask, CODES, PLAN_KINDS } = require('../lib/experience/bounded-reask');

function transient(overrides = {}) {
  return { kind: 'transient', fingerprint: 'fp-1', stepId: 's1', attemptId: 'att-old', ...overrides };
}

const accepts = () => ({ ok: true });
const rejects = () => ({ ok: false, code: 'still_invalid' });

describe('a plain reask uses the repair planner as-is', () => {
  it('plans a reask with fresh identity, no approval and growing budget', () => {
    const reask = createBoundedReask();
    const first = reask.planReask({ failure: transient(), budget: { attemptsUsed: 0 } });
    assert.equal(first.ok, true);
    assert.equal(first.plan.kind, PLAN_KINDS.REASK);
    assert.equal(first.plan.fixValue, null);
    assert.notEqual(first.plan.attemptId, 'att-old');
    assert.equal(first.plan.approval, null);
    assert.equal(first.plan.approvalRequired, true);
    assert.deepEqual(first.plan.budgetAfter, { attemptsUsed: 1, maxAttempts: 3 });

    const second = reask.planReask({ failure: transient(), budget: first.plan.budgetAfter });
    assert.equal(second.plan.backoffMs, 2000);
    assert.notEqual(second.plan.attemptId, first.plan.attemptId);
  });
});

describe('a fix is applied only after re-validation', () => {
  it('a re-validated fix plans a fix and records before/after', () => {
    const reask = createBoundedReask({ fix: () => 'fixed', revalidate: accepts });
    const planned = reask.planReask({ failure: transient({ value: 'broken' }), budget: { attemptsUsed: 0 } });
    assert.equal(planned.ok, true);
    assert.equal(planned.plan.kind, PLAN_KINDS.FIX);
    assert.equal(planned.plan.fixValue, 'fixed');
    assert.equal(planned.plan.before, 'broken');
    assert.equal(planned.plan.after, 'fixed');
    assert.equal(planned.plan.fixNotRevalidated, false);
    // A fix is still a retry: it draws on the same persisted budget.
    assert.deepEqual(planned.plan.budgetAfter, { attemptsUsed: 1, maxAttempts: 3 });
  });

  it('a fix that fails re-validation is dropped and a reask is planned', () => {
    const reask = createBoundedReask({ fix: () => 'fixed', revalidate: rejects });
    const planned = reask.planReask({ failure: transient(), budget: { attemptsUsed: 0 } });
    assert.equal(planned.ok, true);
    assert.equal(planned.plan.kind, PLAN_KINDS.REASK);
    assert.equal(planned.plan.fixValue, null);
    assert.equal(planned.plan.fixNotRevalidated, true);
  });

  it('a fix that produces nothing falls through to a reask', () => {
    const reask = createBoundedReask({ fix: () => null, revalidate: accepts });
    const planned = reask.planReask({ failure: transient(), budget: { attemptsUsed: 0 } });
    assert.equal(planned.ok, true);
    assert.equal(planned.plan.kind, PLAN_KINDS.REASK);
    assert.equal(planned.plan.fixNotRevalidated, false);
  });
});

describe('an un-checkable fix is refused, not applied', () => {
  it('a fix with no revalidate is refused', () => {
    const reask = createBoundedReask({ fix: () => 'fixed' });
    assert.deepEqual(
      reask.planReask({ failure: transient(), budget: { attemptsUsed: 0 } }),
      { ok: false, code: CODES.REVALIDATION_REQUIRED });
  });

  it('a fixer that throws is a fault, never a silent reask', () => {
    const reask = createBoundedReask({ fix: () => { throw new Error('boom'); }, revalidate: accepts });
    const planned = reask.planReask({ failure: transient(), budget: { attemptsUsed: 0 } });
    assert.equal(planned.ok, false);
    assert.equal(planned.code, CODES.REVALIDATION_FAULTED);
    assert.equal(planned.cause, 'boom');
  });

  it('a re-validator that throws is a fault, never an accepted fix', () => {
    const reask = createBoundedReask({ fix: () => 'fixed', revalidate: () => { throw new Error('gate exploded'); } });
    const planned = reask.planReask({ failure: transient(), budget: { attemptsUsed: 0 } });
    assert.equal(planned.ok, false);
    assert.equal(planned.code, CODES.REVALIDATION_FAULTED);
    assert.equal(planned.cause, 'gate exploded');
  });
});

describe('a fix opens no authority the reask loop would refuse', () => {
  it('a policy block is refused before any fix is attempted', () => {
    let fixCalled = false;
    const reask = createBoundedReask({ fix: () => { fixCalled = true; return 'fixed'; }, revalidate: accepts });
    const planned = reask.planReask({ failure: transient({ kind: 'policy-blocked' }), budget: { attemptsUsed: 0 } });
    assert.equal(planned.ok, false);
    assert.equal(planned.code, 'reask_repair_blocked_by_policy');
    assert.equal(fixCalled, false, 'the fix must not run on a policy block');
  });

  it('a permanent failure is not repairable', () => {
    const reask = createBoundedReask({ fix: () => 'fixed', revalidate: accepts });
    assert.deepEqual(
      reask.planReask({ failure: transient({ kind: 'permanent' }), budget: { attemptsUsed: 0 } }),
      { ok: false, code: 'reask_not_repairable' });
  });

  it('an exhausted budget proposes nothing, fix or not', () => {
    const reask = createBoundedReask({ fix: () => 'fixed', revalidate: accepts });
    assert.deepEqual(
      reask.planReask({ failure: transient(), budget: { attemptsUsed: 3 } }),
      { ok: false, code: 'reask_budget_exhausted' });
  });
});
