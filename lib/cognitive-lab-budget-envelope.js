'use strict';

/**
 * Cognitive Lab locked budget envelope (#3414, slice 3308-P2).
 *
 * A paired gain is only admissible if both arms spent the same pre-declared
 * budget. The envelope is locked before either arm runs: the ceiling per arm,
 * the accounting unit and the overrun policy are frozen, so no threshold can be
 * chosen after seeing which arm was cheaper. After a run the two sides report
 * observed consumption; a mismatch between the sides or any overrun is a
 * REJECT, and a side that did not report is UNKNOWN -- never assumed to be
 * zero. Because usage is compared against the locked ceiling, an arm cannot buy
 * a better Brier with extra work and still be scored as a gain.
 *
 * Scope: a pure module plus its tests. It reads no store and adds no runtime
 * surface; the equal-budget caller is the paired delta (and, later, the
 * isolated CLI surface).
 */

const { isPlainObject } = require('./is-plain-object');

const BUDGET_ENVELOPE_SCHEMA_VERSION = 'huqan-cognitive-lab-budget-envelope-v1';

const BUDGET_STATUS = Object.freeze({
  MATCHED: 'MATCHED',
  UNKNOWN: 'UNKNOWN',
  REJECT: 'REJECT',
});

const BUDGET_ERROR_CODES = Object.freeze({
  MISSING_FIELD: 'budget_missing_field',
  UNKNOWN_FIELD: 'budget_unknown_field',
  INVALID_FIELD: 'budget_invalid_field',
  NON_FINITE_NUMBER: 'budget_non_finite_number',
});

const BUDGET_UNIT = 'tokens';
const OVERRUN_POLICY = 'reject';

class BudgetEnvelopeError extends Error {
  constructor(code, path, message) {
    super(message);
    this.name = 'BudgetEnvelopeError';
    this.code = code;
    this.path = path;
  }
}

const ENVELOPE_SPEC = Object.freeze({
  maxTokensPerArm: { kind: 'nonNegativeNumber' },
  maxCallsPerArm: { kind: 'nonNegativeInteger' },
  unit: { kind: 'literal', value: BUDGET_UNIT },
  overrunPolicy: { kind: 'literal', value: OVERRUN_POLICY },
});

function fail(code, path, message) {
  throw new BudgetEnvelopeError(code, path, message);
}

function checkEnvelopeField(spec, value, path) {
  switch (spec.kind) {
    case 'literal':
      if (value !== spec.value) fail(BUDGET_ERROR_CODES.INVALID_FIELD, path, `${path} must be ${spec.value}`);
      return value;
    case 'nonNegativeInteger':
      if (!Number.isInteger(value) || value < 0) {
        fail(BUDGET_ERROR_CODES.INVALID_FIELD, path, `${path} must be a non-negative integer`);
      }
      return value;
    case 'nonNegativeNumber':
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        if (typeof value === 'number' && !Number.isFinite(value)) fail(BUDGET_ERROR_CODES.NON_FINITE_NUMBER, path, `${path} must be finite`);
        fail(BUDGET_ERROR_CODES.INVALID_FIELD, path, `${path} must be a finite number >= 0`);
      }
      return value;
    default:
      fail(BUDGET_ERROR_CODES.INVALID_FIELD, path, `${path} has an unknown envelope kind`);
  }
  return value;
}

/**
 * Validate and freeze a budget envelope. Every field is required: a default set
 * at scoring time would be a ceiling the experiment did not freeze. Unknown
 * fields are rejected so a caller cannot smuggle a larger ceiling past it.
 */
function lockBudgetEnvelope(envelope) {
  if (!isPlainObject(envelope)) fail(BUDGET_ERROR_CODES.MISSING_FIELD, 'envelope', 'envelope is required');
  const locked = {};
  for (const [field, spec] of Object.entries(ENVELOPE_SPEC)) {
    if (!Object.prototype.hasOwnProperty.call(envelope, field)) {
      fail(BUDGET_ERROR_CODES.MISSING_FIELD, field, `envelope.${field} is required`);
    }
    locked[field] = checkEnvelopeField(spec, envelope[field], field);
  }
  for (const field of Object.keys(envelope)) {
    if (!Object.prototype.hasOwnProperty.call(ENVELOPE_SPEC, field)) {
      fail(BUDGET_ERROR_CODES.UNKNOWN_FIELD, field, `envelope.${field} is not part of the envelope`);
    }
  }
  return Object.freeze(locked);
}

// A side that reported nothing is UNKNOWN, never an implicit zero. A reported
// usage must be finite and non-negative or it is not a measurement.
function readUsage(usage, arm) {
  if (usage === null || usage === undefined) return null;
  if (!isPlainObject(usage)) fail(BUDGET_ERROR_CODES.INVALID_FIELD, arm, `${arm} usage must be an object`);
  for (const field of ['tokens', 'calls']) {
    if (!Object.prototype.hasOwnProperty.call(usage, field)) {
      fail(BUDGET_ERROR_CODES.MISSING_FIELD, `${arm}.${field}`, `${arm}.${field} is required`);
    }
    const value = usage[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      if (typeof value === 'number' && !Number.isFinite(value)) fail(BUDGET_ERROR_CODES.NON_FINITE_NUMBER, `${arm}.${field}`, `${arm}.${field} must be finite`);
      fail(BUDGET_ERROR_CODES.INVALID_FIELD, `${arm}.${field}`, `${arm}.${field} must be a finite number >= 0`);
    }
  }
  return Object.freeze({ tokens: usage.tokens, calls: usage.calls });
}

/**
 * Compare two arms' reported usage against one locked envelope. Returns
 * MATCHED only when both sides reported, neither overran either ceiling, and
 * both reported the same amount; a disagreement is REJECT, a missing side is
 * UNKNOWN. `assertsEqualBudget` is the single flag the paired report reads.
 */
function budgetUsageCheck({ envelope, baseline, candidate } = {}) {
  const locked = lockBudgetEnvelope(envelope);
  const base = readUsage(baseline, 'baseline');
  const cand = readUsage(candidate, 'candidate');
  const observed = Object.freeze({ baseline: base, candidate: cand });

  if (base === null || cand === null) {
    return Object.freeze({
      schemaVersion: BUDGET_ENVELOPE_SCHEMA_VERSION,
      status: BUDGET_STATUS.UNKNOWN,
      envelope: locked,
      observed,
      overrun: Object.freeze({ baseline: false, candidate: false }),
      assertsEqualBudget: false,
      reason: 'usage_not_reported',
    });
  }

  const overrun = Object.freeze({
    baseline: base.tokens > locked.maxTokensPerArm || base.calls > locked.maxCallsPerArm,
    candidate: cand.tokens > locked.maxTokensPerArm || cand.calls > locked.maxCallsPerArm,
  });
  if (overrun.baseline || overrun.candidate) {
    return Object.freeze({
      schemaVersion: BUDGET_ENVELOPE_SCHEMA_VERSION,
      status: BUDGET_STATUS.REJECT,
      envelope: locked,
      observed,
      overrun,
      assertsEqualBudget: false,
      reason: 'budget_overrun',
    });
  }
  if (base.tokens !== cand.tokens || base.calls !== cand.calls) {
    return Object.freeze({
      schemaVersion: BUDGET_ENVELOPE_SCHEMA_VERSION,
      status: BUDGET_STATUS.REJECT,
      envelope: locked,
      observed,
      overrun,
      assertsEqualBudget: false,
      reason: 'budget_mismatch',
    });
  }
  return Object.freeze({
    schemaVersion: BUDGET_ENVELOPE_SCHEMA_VERSION,
    status: BUDGET_STATUS.MATCHED,
    envelope: locked,
    observed,
    overrun,
    assertsEqualBudget: true,
    reason: 'equal_budget_verified',
  });
}

module.exports = {
  BUDGET_ENVELOPE_SCHEMA_VERSION,
  BUDGET_STATUS,
  BUDGET_ERROR_CODES,
  BUDGET_UNIT,
  OVERRUN_POLICY,
  BudgetEnvelopeError,
  lockBudgetEnvelope,
  budgetUsageCheck,
};
