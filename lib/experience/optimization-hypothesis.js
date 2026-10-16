'use strict';

/**
 * Experience — Optimization hypothesis (design comment on #2397, R3
 * Phase 9).
 *
 * A hypothesis is a typed, evidence-triggered claim about one existing
 * capability — never free text, never model-generated. Each detector here
 * names the exact evidence window and the exact threshold crossed, and is
 * reproducible from the same Experience history by a second reader: given
 * the same `events` array and the same options, the returned hypothesis is
 * byte-identical (no wall-clock default is used unless the caller omits
 * `now`, in which case the record is naturally non-reproducible — callers
 * that need reproducibility pass `now` explicitly, the same convention
 * `router.js`'s `decideRoute()` uses for its own determinism claim).
 *
 * Three bounded shapes only, matching the design comment exactly:
 *
 * - `latency_regression`: trailing-window median duration of
 *   `positive_procedure` runs exceeds the all-time median by a configured
 *   factor, gated by a minimum sample-size floor so it never fires on
 *   noise from a tiny sample.
 * - `success_rate_decline`: trailing-window `negative_example` rate
 *   exceeds the rate recorded at the capability's last promotion.
 * - `cost_regression`: trailing-window aggregate `totalCost` (via
 *   `./canary.js`'s `computeTotalCost` — the one authority for that
 *   formula, not re-derived here) exceeds the value recorded at last
 *   promotion.
 *
 * A hypothesis does not itself produce a candidate procedure; it is the
 * trigger that makes compiling one (via `./compiler.js`) a justified
 * action instead of speculative churn. This module is pure: no I/O, no
 * storage, no journal/registry import.
 */

const crypto = require('node:crypto');
const { computeTotalCost } = require('./canary');

const HYPOTHESIS_TYPES = Object.freeze({
  LATENCY_REGRESSION: 'latency_regression',
  SUCCESS_RATE_DECLINE: 'success_rate_decline',
  COST_REGRESSION: 'cost_regression',
});

const DAY_MS = 24 * 60 * 60 * 1000;

// Mirrors capability-trust.js's MIN_EXECUTIONS_FOR_TRUST convention: below
// this many in-window samples, nothing is known yet and no hypothesis may
// fire — this is what stops a two-run blip from reading as a regression.
const MIN_SAMPLE_SIZE_FOR_HYPOTHESIS = 10;
// Mirrors capability-trust.js's TRUSTED_WINDOW_RUNS / TRUSTED_WINDOW_DAYS:
// the trailing window is whichever of "last N runs" or "last T days" is
// the smaller (more restrictive) set.
const DEFAULT_TRAILING_WINDOW_RUNS = 50;
const DEFAULT_TRAILING_WINDOW_DAYS = 30;
// A trailing-window median must exceed the all-time median by at least
// this factor to count as a latency regression, not ordinary variance.
const DEFAULT_LATENCY_REGRESSION_FACTOR = 1.5;

const POSITIVE = 'positive_procedure';
const NEGATIVE = 'negative_example';

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function stableKey(value) {
  if (value === undefined) return '';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableKey(value[k])}`).join(',')}}`;
}

function median(numbers) {
  if (numbers.length === 0) return null;
  const sorted = numbers.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * The smaller (more restrictive) of "last `windowRuns` runs" and "last
 * `windowDays` days" — same convention as capability-trust.js's
 * `activeWindowEvents()`, reimplemented locally because this module's
 * events are not scoped to a `boundProcedureVersion` the way that
 * module's are (the caller here has already filtered to one capability).
 */
function trailingWindow(events, { windowRuns, windowDays, now }) {
  const cutoff = now - windowDays * DAY_MS;
  const withinDays = events.filter((e) => e.occurredAt >= cutoff);
  const withinRuns = events.slice(-windowRuns);
  return withinDays.length <= withinRuns.length ? withinDays : withinRuns;
}

function evidenceWindowOf(events) {
  if (events.length === 0) return { windowStart: null, windowEnd: null, sampleSize: 0 };
  return {
    windowStart: events[0].occurredAt,
    windowEnd: events[events.length - 1].occurredAt,
    sampleSize: events.length,
  };
}

function buildHypothesis(type, fields) {
  const body = { type, ...fields };
  return Object.freeze({ ...body, hypothesisHash: sha256(stableKey(body)) });
}

/**
 * `latency_regression`: trailing-window median duration of
 * `positive_procedure` runs exceeds the all-time median by
 * `regressionFactor`. `events`: `[{ occurredAt, durationMs,
 * learningEligibility }]`, already scoped by the caller to one capability
 * (and, typically, one procedure version).
 */
function detectLatencyRegression({
  capabilityId, events, now = Date.now(), windowRuns = DEFAULT_TRAILING_WINDOW_RUNS,
  windowDays = DEFAULT_TRAILING_WINDOW_DAYS, regressionFactor = DEFAULT_LATENCY_REGRESSION_FACTOR,
  minSampleSize = MIN_SAMPLE_SIZE_FOR_HYPOTHESIS,
} = {}) {
  const positive = (Array.isArray(events) ? events : [])
    .filter((e) => isRecord(e) && e.learningEligibility === POSITIVE && Number.isFinite(e.durationMs))
    .sort((a, b) => a.occurredAt - b.occurredAt);
  const window = trailingWindow(positive, { windowRuns, windowDays, now });
  const allTimeMedianMs = median(positive.map((e) => e.durationMs));
  const windowMedianMs = median(window.map((e) => e.durationMs));

  const sufficientSample = window.length >= minSampleSize;
  const fires = sufficientSample
    && allTimeMedianMs !== null && allTimeMedianMs > 0
    && windowMedianMs !== null && windowMedianMs > allTimeMedianMs * regressionFactor;

  return {
    ok: true,
    hypothesis: buildHypothesis(HYPOTHESIS_TYPES.LATENCY_REGRESSION, {
      capabilityId: capabilityId || null,
      fires,
      reason: !sufficientSample ? 'insufficient_sample' : fires ? 'threshold_exceeded' : 'within_threshold',
      allTimeMedianMs, windowMedianMs, regressionFactor, minSampleSize,
      evidenceWindow: evidenceWindowOf(window),
    }),
  };
}

/**
 * `success_rate_decline`: trailing-window `negative_example` rate exceeds
 * `rateAtLastPromotion`. `events`: `[{ occurredAt, learningEligibility }]`.
 */
function detectSuccessRateDecline({
  capabilityId, events, rateAtLastPromotion, now = Date.now(),
  windowRuns = DEFAULT_TRAILING_WINDOW_RUNS, windowDays = DEFAULT_TRAILING_WINDOW_DAYS,
  minSampleSize = MIN_SAMPLE_SIZE_FOR_HYPOTHESIS,
} = {}) {
  if (typeof rateAtLastPromotion !== 'number' || !Number.isFinite(rateAtLastPromotion)) {
    return { ok: false, code: 'invalid_promotion_baseline' };
  }
  const scoped = (Array.isArray(events) ? events : [])
    .filter((e) => isRecord(e) && (e.learningEligibility === POSITIVE || e.learningEligibility === NEGATIVE))
    .sort((a, b) => a.occurredAt - b.occurredAt);
  const window = trailingWindow(scoped, { windowRuns, windowDays, now });
  const negativeCount = window.filter((e) => e.learningEligibility === NEGATIVE).length;
  const sufficientSample = window.length >= minSampleSize;
  const windowNegativeRate = window.length > 0 ? negativeCount / window.length : null;

  const fires = sufficientSample && windowNegativeRate !== null && windowNegativeRate > rateAtLastPromotion;

  return {
    ok: true,
    hypothesis: buildHypothesis(HYPOTHESIS_TYPES.SUCCESS_RATE_DECLINE, {
      capabilityId: capabilityId || null,
      fires,
      reason: !sufficientSample ? 'insufficient_sample' : fires ? 'threshold_exceeded' : 'within_threshold',
      rateAtLastPromotion, windowNegativeRate, minSampleSize,
      evidenceWindow: evidenceWindowOf(window),
    }),
  };
}

/**
 * `cost_regression`: trailing-window aggregate `totalCost` exceeds
 * `totalCostAtLastPromotion`. `events`: `[{ occurredAt, learningEligibility,
 * executionCost, verificationCost }]` — steady-state (post-promotion) runs,
 * so `candidateOnly` is always `false` and `canaryOverheadCost` never
 * applies here, per `./canary.js`'s own "never double-counted into
 * steady-state comparisons" rule.
 */
function detectCostRegression({
  capabilityId, events, totalCostAtLastPromotion, now = Date.now(),
  windowRuns = DEFAULT_TRAILING_WINDOW_RUNS, windowDays = DEFAULT_TRAILING_WINDOW_DAYS,
  minSampleSize = MIN_SAMPLE_SIZE_FOR_HYPOTHESIS,
} = {}) {
  if (typeof totalCostAtLastPromotion !== 'number' || !Number.isFinite(totalCostAtLastPromotion)) {
    return { ok: false, code: 'invalid_promotion_baseline' };
  }
  const scoped = (Array.isArray(events) ? events : [])
    .filter((e) => isRecord(e) && (e.learningEligibility === POSITIVE || e.learningEligibility === NEGATIVE))
    .sort((a, b) => a.occurredAt - b.occurredAt);
  const window = trailingWindow(scoped, { windowRuns, windowDays, now });

  let aggregateTotalCost = 0;
  for (const event of window) {
    const cost = computeTotalCost({
      executionCost: event.executionCost, verificationCost: event.verificationCost, candidateOnly: false,
    });
    if (!cost.ok) return { ok: false, code: 'invalid_cost_inputs' };
    aggregateTotalCost += cost.totalCost;
  }

  const sufficientSample = window.length >= minSampleSize;
  const fires = sufficientSample && aggregateTotalCost > totalCostAtLastPromotion;

  return {
    ok: true,
    hypothesis: buildHypothesis(HYPOTHESIS_TYPES.COST_REGRESSION, {
      capabilityId: capabilityId || null,
      fires,
      reason: !sufficientSample ? 'insufficient_sample' : fires ? 'threshold_exceeded' : 'within_threshold',
      totalCostAtLastPromotion, aggregateTotalCost, minSampleSize,
      evidenceWindow: evidenceWindowOf(window),
    }),
  };
}

module.exports = Object.freeze({
  HYPOTHESIS_TYPES,
  MIN_SAMPLE_SIZE_FOR_HYPOTHESIS,
  DEFAULT_TRAILING_WINDOW_RUNS,
  DEFAULT_TRAILING_WINDOW_DAYS,
  DEFAULT_LATENCY_REGRESSION_FACTOR,
  detectLatencyRegression,
  detectSuccessRateDecline,
  detectCostRegression,
});
