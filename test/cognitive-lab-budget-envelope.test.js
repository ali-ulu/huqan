'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BUDGET_STATUS,
  BUDGET_ERROR_CODES,
  BudgetEnvelopeError,
  lockBudgetEnvelope,
  budgetUsageCheck,
} = require('../lib/cognitive-lab-budget-envelope');

const ENVELOPE = Object.freeze({
  maxTokensPerArm: 10_000,
  maxCallsPerArm: 1_000,
  unit: 'tokens',
  overrunPolicy: 'reject',
});

function usage(tokens, calls) {
  return { tokens, calls };
}

test('an envelope with a missing field is rejected rather than defaulted', () => {
  assert.throws(
    () => lockBudgetEnvelope({ maxTokensPerArm: 10, maxCallsPerArm: 1, unit: 'tokens' }),
    (error) => error instanceof BudgetEnvelopeError
      && error.code === BUDGET_ERROR_CODES.MISSING_FIELD,
  );
});

test('an unknown envelope field is rejected so a ceiling cannot be smuggled past it', () => {
  assert.throws(
    () => lockBudgetEnvelope({ ...ENVELOPE, extraTokens: 1 }),
    (error) => error.code === BUDGET_ERROR_CODES.UNKNOWN_FIELD,
  );
});

test('a non-finite ceiling is a typed non-finite error', () => {
  assert.throws(
    () => lockBudgetEnvelope({ ...ENVELOPE, maxTokensPerArm: Number.POSITIVE_INFINITY }),
    (error) => error.code === BUDGET_ERROR_CODES.NON_FINITE_NUMBER,
  );
});

test('the locked envelope is frozen', () => {
  const locked = lockBudgetEnvelope(ENVELOPE);
  assert.ok(Object.isFrozen(locked));
  assert.equal(locked.maxTokensPerArm, 10_000);
});

test('equal reported usage inside both ceilings is MATCHED and asserts the budget', () => {
  const result = budgetUsageCheck({
    envelope: ENVELOPE,
    baseline: usage(4_000, 400),
    candidate: usage(4_000, 400),
  });
  assert.equal(result.status, BUDGET_STATUS.MATCHED);
  assert.equal(result.assertsEqualBudget, true);
  assert.equal(result.reason, 'equal_budget_verified');
});

test('a missing side is UNKNOWN, never an implicit zero', () => {
  const result = budgetUsageCheck({
    envelope: ENVELOPE,
    baseline: usage(4_000, 400),
    candidate: null,
  });
  assert.equal(result.status, BUDGET_STATUS.UNKNOWN);
  assert.equal(result.assertsEqualBudget, false);
  assert.equal(result.observed.candidate, null);
});

test('differing usage is REJECT with a mismatch reason', () => {
  const result = budgetUsageCheck({
    envelope: ENVELOPE,
    baseline: usage(4_000, 400),
    candidate: usage(4_100, 400),
  });
  assert.equal(result.status, BUDGET_STATUS.REJECT);
  assert.equal(result.reason, 'budget_mismatch');
  assert.equal(result.assertsEqualBudget, false);
});

test('an arm over either ceiling is REJECT even when both sides agree', () => {
  const result = budgetUsageCheck({
    envelope: ENVELOPE,
    baseline: usage(10_001, 400),
    candidate: usage(10_001, 400),
  });
  assert.equal(result.status, BUDGET_STATUS.REJECT);
  assert.equal(result.reason, 'budget_overrun');
  assert.equal(result.overrun.baseline, true);
  assert.equal(result.overrun.candidate, true);
});

test('calls over the call ceiling alone is an overrun', () => {
  const result = budgetUsageCheck({
    envelope: ENVELOPE,
    baseline: usage(10, 1_001),
    candidate: usage(10, 1_001),
  });
  assert.equal(result.status, BUDGET_STATUS.REJECT);
  assert.equal(result.reason, 'budget_overrun');
});

test('a reported usage with a non-finite amount is rejected, not read as a match', () => {
  assert.throws(
    () => budgetUsageCheck({
      envelope: ENVELOPE,
      baseline: usage(Number.NaN, 1),
      candidate: usage(Number.NaN, 1),
    }),
    (error) => error.code === BUDGET_ERROR_CODES.NON_FINITE_NUMBER,
  );
});

test('the check output is frozen', () => {
  const result = budgetUsageCheck({ envelope: ENVELOPE, baseline: usage(1, 1), candidate: usage(1, 1) });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.envelope));
});
