'use strict';
// #4065 G1 decision arithmetic, exactly as preregistered (§6, §7).
const { createPairedSampler: mulberry32, pairedPercentile: percentile } = require('./cognitive-lab-paired-delta');

const MIN_EFFECT = 0.15;
const Z_ALPHA = 1.96;
const Z_POWER = 0.84;
const N_MIN = 32;
const N_MAX = 64;
const BOOTSTRAP_REPS = 10000;
const BOOTSTRAP_SEED = 20261027;
const NON_INFERIORITY_MARGIN = -0.05;
const WALL_RATIO_LIMIT = 1.5;
const LABELS = Object.freeze(['REJECT', 'INSUFFICIENT', 'ZARAR', 'GAIN', 'MEASURED_NO_GAIN', 'MEASURED_GATE_FAIL']);

const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

// Sample standard deviation with the n - 1 denominator (§6).
function sampleSd(values) {
  if (!Array.isArray(values) || values.length < 2 || !values.every(Number.isFinite)) throw new TypeError('G1_SD_NEEDS_TWO_FINITE');
  const center = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1));
}

function lockGroupCount(sigma) {
  if (!Number.isFinite(sigma) || sigma < 0) throw new TypeError('G1_SIGMA_INVALID');
  return Math.min(N_MAX, Math.max(N_MIN, Math.ceil(((Z_ALPHA + Z_POWER) * sigma / MIN_EFFECT) ** 2)));
}

// Group score = mean over the three seeds of (candidate rate - control rate).
function groupDelta(seedRuns) {
  return mean(seedRuns.map(run => run.candidate.successes / run.candidate.denominator
    - run.control.successes / run.control.denominator));
}

function pairedBootstrap(deltas, { reps = BOOTSTRAP_REPS, seed = BOOTSTRAP_SEED } = {}) {
  const random = mulberry32(seed);
  const means = [];
  for (let rep = 0; rep < reps; rep += 1) {
    let sum = 0;
    for (let at = 0; at < deltas.length; at += 1) sum += deltas[Math.floor(random() * deltas.length)];
    means.push(sum / deltas.length);
  }
  means.sort((a, b) => a - b);
  return { mean: mean(deltas), lower: percentile(means, 0.025), upper: percentile(means, 0.975), reps, seed };
}

// Exact two-sided sign test; ties are dropped.
function signTest(deltas) {
  const positive = deltas.filter(value => value > 0).length;
  const negative = deltas.filter(value => value < 0).length;
  const n = positive + negative;
  if (!n) return { positive, negative, ties: deltas.length, p: 1 };
  let tail = 0;
  const k = Math.min(positive, negative);
  let coefficient = 1;
  for (let i = 0; i <= k; i += 1) {
    if (i > 0) coefficient = coefficient * (n - i + 1) / i;
    tail += coefficient / 2 ** n;
  }
  return { positive, negative, ties: deltas.length - n, p: Math.min(1, 2 * tail) };
}

// One label per result, by the preregistered priority (§7).
function labelResult({ rejectReasons = [], insufficientReasons = [], interval, stratum, cost }) {
  if (rejectReasons.length) return { label: 'REJECT', reasons: rejectReasons };
  if (insufficientReasons.length) return { label: 'INSUFFICIENT', reasons: insufficientReasons };
  if (interval.upper < 0) return { label: 'ZARAR', reasons: ['interval_upper_below_zero'] };
  const stratumEvaluable = stratum && stratum.groups >= stratum.minGroups;
  const nonInferior = stratumEvaluable && stratum.interval.lower > NON_INFERIORITY_MARGIN;
  const costPasses = cost.modelCalls === 0 && cost.networkCalls === 0 && cost.wallRatio <= WALL_RATIO_LIMIT;
  if (interval.lower <= 0) return { label: 'MEASURED_NO_GAIN', reasons: ['interval_includes_zero'] };
  if (nonInferior && costPasses) return { label: 'GAIN', reasons: ['interval_lower_above_zero', 'non_inferior', 'cost_within_limit'] };
  const failed = [];
  if (!stratumEvaluable) failed.push('non_inferiority_not_evaluable');
  else if (!nonInferior) failed.push('non_inferiority_violated');
  if (!costPasses) failed.push('cost_limit_exceeded');
  return { label: 'MEASURED_GATE_FAIL', reasons: failed };
}

module.exports = { MIN_EFFECT, N_MIN, N_MAX, BOOTSTRAP_REPS, BOOTSTRAP_SEED, NON_INFERIORITY_MARGIN, WALL_RATIO_LIMIT, LABELS,
  mean, median, sampleSd, lockGroupCount, groupDelta, pairedBootstrap, signTest, labelResult };
