'use strict';

/**
 * #3473 (roadmap R18) blind-spot prototype — ACT-R-style base-level activation
 * as a next-access predictor.
 *
 * A #3473 measurement, not a production module. ACT-R's declarative memory
 * ranks a chunk by *base-level activation*,
 *
 *     B_i = ln( sum_j (t - t_j)^(-d) )
 *
 * over its past access times t_j with decay d (0.5 is the classic value). The
 * claim under test is that this recency-plus-frequency combination predicts the
 * next access better than either ingredient alone — pure recency (the most
 * recently used item) or pure frequency (the most used item).
 *
 * The stream is a Zipf-like popularity draw with an optional recency pressure.
 * The three regimes are the ablation: a popularity-only stream favours
 * frequency, a recency-only stream favours recency, and a balanced stream sits
 * between them. A mechanism that wins only where it is expected to is a
 * conditional result, and the record says so.
 *
 * Everything is seeded through the same `mulberry32` the paired-delta contract
 * uses.
 */

const { createPairedSampler } = require('../../lib/cognitive-lab-paired-delta');

const DECAY = 0.5;
const ITEMS = 6;
const HORIZON = 40;

/** Regimes are (alpha, beta): popularity weight and recency weight in the draw. */
const REGIMES = Object.freeze([
  Object.freeze({ name: 'popularity-only', alpha: 3.0, beta: 0.0 }),
  Object.freeze({ name: 'balanced', alpha: 1.5, beta: 1.5 }),
  Object.freeze({ name: 'recency-only', alpha: 0.0, beta: 3.0 }),
]);

const SEEDS = Object.freeze(Array.from({ length: 40 }, (_, i) => 3473 + i));

/** ACT-R base-level activation over the access times, at `now`. */
function baseLevelActivation(accessTimes, now, decay = DECAY) {
  let sum = 0;
  for (const t of accessTimes) sum += (now - t + 1) ** (-decay);
  return sum > 0 ? Math.log(sum) : -Infinity;
}

const SCORERS = Object.freeze({
  recency: (times) => (times.length ? Math.max(...times) : -Infinity),
  frequency: (times) => times.length,
  actr: (times, now) => baseLevelActivation(times, now),
});

function predict(histories, scorer, now) {
  let best = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < histories.length; i += 1) {
    const score = scorer(histories[i], now);
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}

function drawNext(popularity, histories, now, rand, { alpha, beta }) {
  const weights = popularity.map((p, i) => {
    const recency = histories[i].length ? Math.exp(-(now - Math.max(...histories[i])) / 3) : 0;
    return Math.exp(alpha * p + beta * recency);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rand() * total;
  for (let i = 0; i < ITEMS; i += 1) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return ITEMS - 1;
}

/** Top-1 next-access accuracy of each predictor on one seed and regime. */
function runSeed(regime, seed) {
  const rand = createPairedSampler(seed);
  const popularity = Array.from({ length: ITEMS }, () => -Math.log(1 - rand()));
  const histories = Array.from({ length: ITEMS }, () => []);
  const correct = { recency: 0, frequency: 0, actr: 0 };
  let now = 0;
  for (let step = 0; step < HORIZON; step += 1) {
    const pick = drawNext(popularity, histories, now, rand, regime);
    histories[pick].push(now);
    now += 1;
    const actual = drawNext(popularity, histories, now, rand, regime);
    for (const [name, scorer] of Object.entries(SCORERS)) {
      if (predict(histories, scorer, now) === actual) correct[name] += 1;
    }
  }
  return {
    recency: correct.recency / HORIZON,
    frequency: correct.frequency / HORIZON,
    actr: correct.actr / HORIZON,
  };
}

/**
 * Per-seed paired deltas for the candidate (actr) against each baseline
 * predictor, so the ablation reports "better than recency" and "better than
 * frequency" separately rather than against an unnamed average.
 */
function runRegime(regime) {
  const vsRecency = [];
  const vsFrequency = [];
  for (const seed of SEEDS) {
    const result = runSeed(regime, seed);
    vsRecency.push(result.actr - result.recency);
    vsFrequency.push(result.actr - result.frequency);
  }
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    name: regime.name,
    pairs: SEEDS.length,
    vsRecency: { deltas: vsRecency, meanDelta: mean(vsRecency) },
    vsFrequency: { deltas: vsFrequency, meanDelta: mean(vsFrequency) },
  };
}

module.exports = {
  DECAY, ITEMS, HORIZON, REGIMES, SEEDS, SCORERS,
  baseLevelActivation, runSeed, runRegime,
};
