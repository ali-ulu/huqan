'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SURPRISE_CAP_BITS,
  computePredictionError,
  summarizePredictionErrors,
} = require('../lib/cognition/prediction-error');

const AT = '2026-10-19T10:00:00Z';
const base = { decisionId: 'dec_1', key: 'k', at: AT };
const probability = (extra) => ({ ...base, kind: 'probability', p: 0.9, y: 0, probabilitySource: 'cognitive-lab-comparison', ...extra });

test('computes signed error y minus p for explicit probability', () => {
  const r = computePredictionError(probability());
  assert.equal(r.status, 'MEASURED');
  assert.equal(r.signedError, -0.9);
  assert.equal(r.magnitude, 0.9);
  assert.equal(r.surpriseBits, 3.321928);
  assert.equal(r.at, '2026-10-19T10:00:00.000Z');
  assert.equal(r.authority, 'SIGNAL_ONLY');
  assert.deepEqual(r.sourceRefs, ['prediction-outcome:prediction:dec_1']);
});

test('abstains when probabilitySource label is missing', () => {
  const r = computePredictionError(probability({ probabilitySource: '' }));
  assert.equal(r.status, 'ABSTAIN');
  assert.equal(r.reason, 'probability_source_missing');
  assert.equal(r.magnitude, null);
});

test('never converts a 0-100 risk score into a probability', () => {
  const r = computePredictionError({ ...base, kind: 'risk', score: 80, outcome: 'rollback' });
  assert.equal(r.status, 'MEASURED');
  assert.equal(r.signedError, 0);
  assert.equal(r.surpriseBits, null);
  const miss = computePredictionError({ ...base, kind: 'risk', score: 10, outcome: 'rollback' });
  assert.equal(miss.signedError, 1);
  const alarm = computePredictionError({ ...base, kind: 'risk', score: 90, outcome: 'confirmed' });
  assert.equal(alarm.signedError, -1);
  assert.equal(alarm.magnitude, 1);
});

test('abstains on censored or missing outcome instead of scoring success', () => {
  for (const outcome of ['censored', null, 'made-up']) {
    const r = computePredictionError({ ...base, kind: 'risk', score: 5, outcome });
    assert.equal(r.status, 'ABSTAIN');
    assert.equal(r.reason, 'outcome_unknown_or_censored');
  }
  const unscored = computePredictionError({ ...base, kind: 'risk', score: null, outcome: 'confirmed' });
  assert.equal(unscored.reason, 'prediction_unscored');
});

test('maps LearnedCausalEngine MISMATCH differences to bounded magnitude', () => {
  const state = (failure, keyCount) => computePredictionError({ ...base, kind: 'state', failure, keyCount });
  assert.equal(state({ status: 'MISMATCH', differences: ['a'] }, 4).magnitude, 0.25);
  assert.equal(state({ status: 'CONFIRMED', differences: [] }, 4).magnitude, 0);
  assert.equal(state({ status: 'UNKNOWN', reason: 'x' }).reason, 'state_prediction_unknown');
  assert.equal(state({ status: 'MISMATCH', differences: ['a'] }).status, 'REJECT');
  assert.equal(state({ status: 'MISMATCH', differences: ['a', 'b'] }, 1).status, 'REJECT');
});

test('abstains on indeterminate file effect observation', () => {
  const effect = (expected, observed) => computePredictionError({ ...base, kind: 'effect', expected, observed });
  assert.equal(effect('modified', 'indeterminate').reason, 'effect_indeterminate');
  assert.equal(effect('modified', 'modified').magnitude, 0);
  assert.equal(effect('modified', 'unchanged').magnitude, 1);
  assert.equal(effect('indeterminate', 'modified').status, 'REJECT');
});

test('rejects NaN, Infinity, out-of-range p and unknown fields', () => {
  const rejected = [
    probability({ p: NaN }), probability({ p: Infinity }), probability({ p: 1.2 }), probability({ y: 0.5 }),
    { ...base, kind: 'risk', score: 101, outcome: 'confirmed' },
    { ...base, kind: 'risk', score: NaN, outcome: 'confirmed' },
    { ...base, kind: 'nope' }, probability({ extra: 1 }), probability({ at: 'not a date' }), null,
  ];
  for (const input of rejected) assert.equal(computePredictionError(input).status, 'REJECT', JSON.stringify(input));
});

test('caps surprise bits at SURPRISE_CAP_BITS', () => {
  // With SURPRISE_EPSILON = 1e-6 the floor is -log2(1e-6) = 19.931569, so the cap is a ceiling, never exceeded.
  const worst = computePredictionError(probability({ p: 0, y: 1 })).surpriseBits;
  assert.equal(worst, 19.931569);
  assert.ok(worst <= SURPRISE_CAP_BITS);
});

test('does not mutate its input', () => {
  const input = Object.freeze(probability());
  assert.doesNotThrow(() => computePredictionError(input));
});

test('summary orders by at then decisionId and is deterministic', () => {
  const rows = [3, 1, 2, 4].map((n) => computePredictionError(probability({
    decisionId: `d${n}`, at: `2026-10-19T10:00:0${n}Z`, p: 0, y: n % 2,
  })));
  rows.push(computePredictionError(probability({ decisionId: 'd5', probabilitySource: '' })));
  const a = summarizePredictionErrors(rows, { key: 'k', window: 2 });
  const b = summarizePredictionErrors([...rows].reverse(), { key: 'k', window: 2 });
  assert.deepEqual(a, b);
  assert.equal(a.count, 4);
  assert.equal(a.abstained, 1);
  assert.equal(a.recentMean, 0.5);
  assert.equal(a.olderMean, 0.5);
  assert.equal(summarizePredictionErrors(rows, { key: 'k', window: 3 }).olderMean, null);
  assert.equal(summarizePredictionErrors(rows, { key: 'other' }).meanMagnitude, null);
});

test('mutation guard: a censored outcome treated as confirmed would score a signal', () => {
  const censored = computePredictionError({ ...base, kind: 'risk', score: 90, outcome: 'censored' });
  const confirmed = computePredictionError({ ...base, kind: 'risk', score: 90, outcome: 'confirmed' });
  assert.notEqual(censored.status, confirmed.status);
  assert.equal(censored.magnitude, null);
});
