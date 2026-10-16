'use strict';

/**
 * Optimization hypothesis tests (design comment on #2397, R3 Phase 9).
 *
 * Hermetic: no I/O, no storage, no timers, no wall clock (every test
 * passes `now` explicitly so results are reproducible byte-for-byte by a
 * second reader given the same inputs).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  HYPOTHESIS_TYPES,
  MIN_SAMPLE_SIZE_FOR_HYPOTHESIS,
  DEFAULT_LATENCY_REGRESSION_FACTOR,
  detectLatencyRegression,
  detectSuccessRateDecline,
  detectCostRegression,
} = require('../lib/experience/optimization-hypothesis');

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const MIN = 60 * 1000;

function positiveRun(occurredAt, durationMs) {
  return { occurredAt, durationMs, learningEligibility: 'positive_procedure' };
}

describe('Optimization hypothesis: acceptance test 1 — latency_regression sample floor', () => {
  it('does not fire on a genuine-looking spike drawn from too small a sample (noise)', () => {
    // All-time median 100ms from a long healthy history; a *tiny* trailing
    // slice (below the floor) happens to be slow — this must not fire,
    // exactly the "noise from a small sample" the design calls out.
    const allTime = [];
    for (let i = 0; i < 40; i += 1) allTime.push(positiveRun(T0 + i * MIN, 100));
    const tinySlowTail = [
      positiveRun(T0 + 41 * MIN, 900),
      positiveRun(T0 + 42 * MIN, 950),
    ];
    const events = [...allTime, ...tinySlowTail];
    const now = T0 + 43 * MIN;

    const { ok, hypothesis } = detectLatencyRegression({
      capabilityId: 'cap-latency', events, now,
      windowRuns: tinySlowTail.length, windowDays: 1,
    });
    assert.equal(ok, true);
    assert.equal(hypothesis.fires, false);
    assert.equal(hypothesis.reason, 'insufficient_sample');
    assert.ok(hypothesis.evidenceWindow.sampleSize < MIN_SAMPLE_SIZE_FOR_HYPOTHESIS);
  });

  it('fires when a trailing window at/above the floor genuinely exceeds the all-time median by the configured factor', () => {
    const allTime = [];
    for (let i = 0; i < 40; i += 1) allTime.push(positiveRun(T0 + i * MIN, 100));
    const slowWindow = [];
    for (let i = 0; i < MIN_SAMPLE_SIZE_FOR_HYPOTHESIS; i += 1) {
      slowWindow.push(positiveRun(T0 + (41 + i) * MIN, 100 * DEFAULT_LATENCY_REGRESSION_FACTOR + 50));
    }
    const events = [...allTime, ...slowWindow];
    const now = T0 + (41 + MIN_SAMPLE_SIZE_FOR_HYPOTHESIS) * MIN;

    const { hypothesis } = detectLatencyRegression({
      capabilityId: 'cap-latency', events, now,
      windowRuns: slowWindow.length, windowDays: 1,
    });
    assert.equal(hypothesis.fires, true);
    assert.equal(hypothesis.type, HYPOTHESIS_TYPES.LATENCY_REGRESSION);
    assert.equal(hypothesis.evidenceWindow.sampleSize, MIN_SAMPLE_SIZE_FOR_HYPOTHESIS);
    // Reproducible: same inputs, same hash.
    const again = detectLatencyRegression({
      capabilityId: 'cap-latency', events, now, windowRuns: slowWindow.length, windowDays: 1,
    });
    assert.equal(again.hypothesis.hypothesisHash, hypothesis.hypothesisHash);
  });

  it('does not fire when the trailing window is large enough but within the factor', () => {
    const allTime = [];
    for (let i = 0; i < 40; i += 1) allTime.push(positiveRun(T0 + i * MIN, 100));
    const mildWindow = [];
    for (let i = 0; i < MIN_SAMPLE_SIZE_FOR_HYPOTHESIS; i += 1) {
      mildWindow.push(positiveRun(T0 + (41 + i) * MIN, 110));
    }
    const events = [...allTime, ...mildWindow];
    const now = T0 + (41 + MIN_SAMPLE_SIZE_FOR_HYPOTHESIS) * MIN;
    const { hypothesis } = detectLatencyRegression({
      capabilityId: 'cap-latency', events, now, windowRuns: mildWindow.length, windowDays: 1,
    });
    assert.equal(hypothesis.fires, false);
    assert.equal(hypothesis.reason, 'within_threshold');
  });
});

describe('Optimization hypothesis: success_rate_decline', () => {
  it('fires only once the trailing negative rate exceeds the rate at last promotion, with the sample floor applied', () => {
    const events = [];
    for (let i = 0; i < MIN_SAMPLE_SIZE_FOR_HYPOTHESIS; i += 1) {
      events.push({
        occurredAt: T0 + i * MIN,
        learningEligibility: i < 4 ? 'negative_example' : 'positive_procedure',
      });
    }
    const now = T0 + MIN_SAMPLE_SIZE_FOR_HYPOTHESIS * MIN;
    const declined = detectSuccessRateDecline({
      capabilityId: 'cap-success', events, rateAtLastPromotion: 0.1, now,
      windowRuns: events.length, windowDays: 1,
    });
    assert.equal(declined.hypothesis.fires, true);

    const notDeclined = detectSuccessRateDecline({
      capabilityId: 'cap-success', events, rateAtLastPromotion: 0.9, now,
      windowRuns: events.length, windowDays: 1,
    });
    assert.equal(notDeclined.hypothesis.fires, false);
  });

  it('refuses without a numeric promotion baseline', () => {
    const res = detectSuccessRateDecline({ capabilityId: 'cap-x', events: [], rateAtLastPromotion: 'bad' });
    assert.equal(res.ok, false);
  });
});

describe('Optimization hypothesis: cost_regression', () => {
  it('fires when trailing aggregate totalCost exceeds the value recorded at last promotion', () => {
    const events = [];
    for (let i = 0; i < MIN_SAMPLE_SIZE_FOR_HYPOTHESIS; i += 1) {
      events.push({
        occurredAt: T0 + i * MIN,
        learningEligibility: 'positive_procedure',
        executionCost: 10,
        verificationCost: 5,
      });
    }
    const now = T0 + MIN_SAMPLE_SIZE_FOR_HYPOTHESIS * MIN;
    const { hypothesis } = detectCostRegression({
      capabilityId: 'cap-cost', events, totalCostAtLastPromotion: 100, now,
      windowRuns: events.length, windowDays: 1,
    });
    // 10 runs * (10 + 5) = 150 > 100.
    assert.equal(hypothesis.fires, true);
    assert.equal(hypothesis.aggregateTotalCost, 150);
  });

  it('does not fire when the aggregate stays at or below the promotion baseline', () => {
    const events = [];
    for (let i = 0; i < MIN_SAMPLE_SIZE_FOR_HYPOTHESIS; i += 1) {
      events.push({
        occurredAt: T0 + i * MIN,
        learningEligibility: 'positive_procedure',
        executionCost: 1,
        verificationCost: 1,
      });
    }
    const now = T0 + MIN_SAMPLE_SIZE_FOR_HYPOTHESIS * MIN;
    const { hypothesis } = detectCostRegression({
      capabilityId: 'cap-cost', events, totalCostAtLastPromotion: 1000, now,
      windowRuns: events.length, windowDays: 1,
    });
    assert.equal(hypothesis.fires, false);
  });
});
