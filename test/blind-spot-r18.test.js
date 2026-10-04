'use strict';

/**
 * #3473 (roadmap R18) — the blind-spot research record has to be reproducible.
 *
 * `docs/research/blind-spot-r18-20261004.md` reports two prototype measurements
 * and a keep/reject verdict for each. This file re-runs both harnesses and
 * pins the reported signs and magnitudes, so the record cannot drift away from
 * what the code actually produces. It also pins determinism: the same seed must
 * reproduce the same result, because a "measurement" that moves between runs is
 * not one.
 *
 * The point of the assertions is the *shape* of the result, not the exact
 * decimal: the Active-Inference candidate must win when the environment drifts
 * and must be exactly neutral when it does not; ACT-R must beat recency on a
 * popularity stream and lose to both baselines on a recency stream. Those are
 * the claims the record makes, so those are what is checked.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createPairedSampler } = require('../lib/cognitive-lab-paired-delta');
const {
  REGIMES: AI_REGIMES, runRegime: runActiveInference, runArm,
} = require('./helpers/blind-spot-active-inference');
const {
  REGIMES: ACTR_REGIMES, runSeed, runRegime: runActr,
} = require('./helpers/blind-spot-actr');

const REPO_ROOT = path.resolve(__dirname, '..');
const RECORD = path.join(REPO_ROOT, 'docs', 'research', 'blind-spot-r18-20261004.md');
const CONTRACT = Object.freeze({ seed: 3473, resamples: 2000, confidenceLevel: 0.95 });

/** The same percentile bootstrap the B6 contract uses, over paired deltas. */
function bootstrapInterval(deltas, contract) {
  const random = createPairedSampler(contract.seed);
  const n = deltas.length;
  const means = [];
  for (let i = 0; i < contract.resamples; i += 1) {
    let sum = 0;
    for (let j = 0; j < n; j += 1) sum += deltas[Math.floor(random() * n)];
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  const alpha = 1 - contract.confidenceLevel;
  const at = (fraction) => means[Math.min(means.length - 1, Math.max(0, Math.floor(fraction * means.length)))];
  return { lower: at(alpha / 2), upper: at(1 - alpha / 2) };
}

const byName = (regimes, name) => regimes.find((r) => r.name === name);

test('#3473: the research record exists and states both verdicts', () => {
  assert.ok(fs.existsSync(RECORD));
  const text = fs.readFileSync(RECORD, 'utf8');
  assert.match(text, /Active Inference/);
  assert.match(text, /ACT-R/);
  assert.match(text, /PROVISIONAL/);
  assert.match(text, /REJECT/);
  // The honesty boundary must be present: synthetic harness, not the live loop.
  assert.match(text, /Kanıt sınırı/);
});

test('#3473: the Active-Inference harness is deterministic per seed', () => {
  const regime = byName(AI_REGIMES, 'drifting-wide-gap');
  const first = runArm(regime, 3473, { epistemic: true });
  const second = runArm(regime, 3473, { epistemic: true });
  assert.equal(first, second, 'the same seed must reproduce the same reward');
});

test('#3473 prototype A — epistemic exploration wins under drift, neutral when stationary', () => {
  const wide = runActiveInference(byName(AI_REGIMES, 'drifting-wide-gap'));
  const narrow = runActiveInference(byName(AI_REGIMES, 'drifting-narrow-gap'));
  const stationary = runActiveInference(byName(AI_REGIMES, 'stationary-control'));

  const wideCI = bootstrapInterval(wide.deltas, CONTRACT);
  const narrowCI = bootstrapInterval(narrow.deltas, CONTRACT);

  assert.ok(wide.meanDelta > 0.4, `wide-gap gain must be large, got ${wide.meanDelta}`);
  assert.ok(wideCI.lower > 0, 'the wide-gap gain must clear zero');
  assert.ok(narrow.meanDelta > 0.15, `narrow-gap gain must be positive, got ${narrow.meanDelta}`);
  assert.ok(narrowCI.lower > 0, 'the narrow-gap gain must clear zero');
  // The ablation's decisive result: no drift, no difference — not a small one.
  assert.equal(stationary.meanDelta, 0, 'a stationary environment must show exactly no gain');
});

test('#3473: the ACT-R harness is deterministic per seed', () => {
  const regime = byName(ACTR_REGIMES, 'balanced');
  assert.deepEqual(runSeed(regime, 3473), runSeed(regime, 3473));
});

test('#3473 prototype B — ACT-R beats recency under popularity, loses under recency', () => {
  const popularity = runActr(byName(ACTR_REGIMES, 'popularity-only'));
  const balanced = runActr(byName(ACTR_REGIMES, 'balanced'));
  const recency = runActr(byName(ACTR_REGIMES, 'recency-only'));

  const popRecencyCI = bootstrapInterval(popularity.vsRecency.deltas, CONTRACT);
  const popFrequencyCI = bootstrapInterval(popularity.vsFrequency.deltas, CONTRACT);
  const recencyVsRecencyCI = bootstrapInterval(recency.vsRecency.deltas, CONTRACT);
  const recencyVsFrequencyCI = bootstrapInterval(recency.vsFrequency.deltas, CONTRACT);

  // Where the mechanism is expected to help: it beats recency, clearly.
  assert.ok(popularity.vsRecency.meanDelta > 0.03, 'ACT-R must beat recency on a popularity stream');
  assert.ok(popRecencyCI.lower > 0, 'the popularity-stream recency gain must clear zero');
  // But it is not better than plain frequency there — so it is not a dominance win.
  assert.ok(popFrequencyCI.lower <= 0 && popFrequencyCI.upper >= 0,
    'against frequency on a popularity stream, the interval must include zero');

  // The balanced stream is where it is genuinely additive.
  assert.ok(balanced.vsRecency.meanDelta > 0 && balanced.vsFrequency.meanDelta > 0);

  // Where it loses: a recency stream defeats it on recency, though it still
  // edges out plain frequency — which is exactly why it is not a clean win.
  assert.ok(recency.vsRecency.meanDelta < -0.08, 'ACT-R must lose to recency on a recency stream');
  assert.ok(recencyVsRecencyCI.upper < 0, 'the recency-stream loss must clear zero');
  assert.ok(recency.vsFrequency.meanDelta > 0, 'ACT-R still edges out frequency on a recency stream');
  assert.ok(recencyVsFrequencyCI.lower > 0, 'the frequency edge must clear zero');
});
