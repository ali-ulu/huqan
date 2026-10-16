'use strict';

/**
 * Experience Phase 5 — repair planning tests (#2391).
 *
 * Hermetic: no I/O, no storage, no timers (backoff is computed, not slept).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createRepairPolicy } = require('../lib/experience/repair');

function transient(overrides = {}) {
  return {
    kind: 'transient', fingerprint: 'fp-1', stepId: 'step-2', attemptId: 'att-old',
    ...overrides,
  };
}

describe('Phase 5: transient failures plan fresh repairs', () => {
  it('plans with a new identity, no approval, and growing backoff', () => {
    const policy = createRepairPolicy({ maxAttempts: 3, backoffBaseMs: 1000, backoffMaxMs: 30000 });
    const first = policy.planRepair({ failure: transient(), budget: { attemptsUsed: 0 } });
    assert.equal(first.ok, true);
    assert.notEqual(first.plan.attemptId, 'att-old');
    assert.notEqual(first.plan.invocationId, first.plan.attemptId);
    assert.equal(first.plan.approval, null);
    assert.equal(first.plan.approvalRequired, true);
    assert.equal(first.plan.backoffMs, 1000);
    assert.deepEqual(first.plan.budgetAfter, { attemptsUsed: 1, maxAttempts: 3 });

    const second = policy.planRepair({ failure: transient(), budget: first.plan.budgetAfter });
    assert.equal(second.plan.backoffMs, 2000);
    assert.notEqual(second.plan.attemptId, first.plan.attemptId);
  });

  it('backoff caps instead of growing forever', () => {
    const policy = createRepairPolicy({ maxAttempts: 10, backoffBaseMs: 1000, backoffMaxMs: 2500 });
    const res = policy.planRepair({ failure: transient(), budget: { attemptsUsed: 5 } });
    assert.equal(res.plan.backoffMs, 2500);
  });

  it('missing budget starts at zero', () => {
    const policy = createRepairPolicy();
    const res = policy.planRepair({ failure: transient() });
    assert.equal(res.ok, true);
    assert.deepEqual(res.plan.budgetAfter, { attemptsUsed: 1, maxAttempts: 3 });
  });
});

describe('Phase 5: refusals', () => {
  it('policy blocks cannot be opened by repair', () => {
    const policy = createRepairPolicy();
    assert.deepEqual(
      policy.planRepair({ failure: transient({ kind: 'policy-blocked' }), budget: { attemptsUsed: 0 } }),
      { ok: false, code: 'repair_blocked_by_policy' });
  });

  it('permanent failures are not repairable', () => {
    const policy = createRepairPolicy();
    assert.deepEqual(
      policy.planRepair({ failure: transient({ kind: 'permanent' }) }),
      { ok: false, code: 'not_repairable' });
  });

  it('unclassified failures are refused, not guessed', () => {
    const policy = createRepairPolicy();
    assert.deepEqual(
      policy.planRepair({ failure: transient({ kind: 'mysterious' }) }),
      { ok: false, code: 'unclassified_failure' });
    assert.deepEqual(policy.planRepair({ failure: {} }),
      { ok: false, code: 'invalid_input' });
  });

  it('exhausted budgets refuse with the count intact', () => {
    const policy = createRepairPolicy({ maxAttempts: 2 });
    assert.deepEqual(
      policy.planRepair({ failure: transient(), budget: { attemptsUsed: 2 } }),
      { ok: false, code: 'budget_exhausted' });
  });
});
