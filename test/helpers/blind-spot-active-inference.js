'use strict';

/**
 * #3473 (roadmap R18) blind-spot prototype — Active-Inference-style epistemic
 * exploration as a candidate selection policy.
 *
 * A #3473 measurement, not a production module: it lives under `test/` so it
 * adds no shipped surface. It asks one narrow question — does adding an
 * uncertainty bonus to a pragmatic-only selector buy anything when the
 * environment *changes*, and does it cost anything when it does not?
 *
 * The model is a two-arm drifting bandit. One arm is best for the first half of
 * the horizon, the other for the second half, so a purely pragmatic selector
 * locks onto the first-best arm and never notices the switch. The candidate
 * adds `1 / sqrt(n + 1)` (a standard optimism/uncertainty term) to each arm's
 * estimated value.
 *
 * The three regimes are the ablation: a popularity-only stream (no switch), a
 * balanced stream, and a recency-only stream. A mechanism that only wins on one
 * of them is not a general improvement, and the record says so.
 *
 * Everything is seeded through the same `mulberry32` the paired-delta contract
 * uses, so the same seed reproduces the same numbers byte for byte.
 */

const { createPairedSampler } = require('../../lib/cognitive-lab-paired-delta');

const ARMS = Object.freeze(['A', 'B']);

/**
 * Regimes are (gap, switchAt): how much better the correct arm is, and when the
 * correct arm changes. `switchAt >= horizon` means the environment never
 * changes — the stationary control.
 */
const REGIMES = Object.freeze([
  Object.freeze({ name: 'drifting-wide-gap', gap: 1.0, switchAt: 200 }),
  Object.freeze({ name: 'drifting-narrow-gap', gap: 0.5, switchAt: 200 }),
  Object.freeze({ name: 'stationary-control', gap: 1.0, switchAt: 100000 }),
]);

const HORIZON = 400;
const SEEDS = Object.freeze(Array.from({ length: 30 }, (_, i) => 3473 + i));

/** The mean reward per step for one arm on one seed. */
function runArm(regime, seed, { epistemic }) {
  const rand = createPairedSampler(seed);
  const counts = { A: 0, B: 0 };
  const sums = { A: 0, B: 0 };
  let total = 0;
  for (let t = 0; t < HORIZON; t += 1) {
    const best = t < regime.switchAt ? 'A' : 'B';
    const scores = ARMS.map((arm) => {
      const mean = counts[arm] ? sums[arm] / counts[arm] : 0;
      const bonus = epistemic ? 1 / Math.sqrt(counts[arm] + 1) : 0;
      return mean + bonus;
    });
    const pick = scores[1] > scores[0] ? 'B' : 'A';
    const reward = (pick === best ? regime.gap : 0) + (rand() - 0.5) * 0.5;
    counts[pick] += 1;
    sums[pick] += reward;
    total += reward;
  }
  return total / HORIZON;
}

/**
 * Per-seed paired deltas (candidate − baseline) for one regime. Pairing on the
 * seed removes the between-run noise, so the ablation compares the policy
 * change and not the environment draw.
 */
function runRegime(regime) {
  const deltas = SEEDS.map((seed) => {
    const baseline = runArm(regime, seed, { epistemic: false });
    const candidate = runArm(regime, seed, { epistemic: true });
    return candidate - baseline;
  });
  const mean = deltas.reduce((sum, d) => sum + d, 0) / deltas.length;
  return { name: regime.name, deltas, meanDelta: mean, pairs: deltas.length };
}

module.exports = {
  ARMS, REGIMES, HORIZON, SEEDS, runArm, runRegime,
};
