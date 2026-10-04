'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeManifestDigest } = require('../lib/cognitive-lab-manifest');
const { buildComparisonManifest, verifyComparisonManifest } = require('../lib/cognitive-lab-comparison-contract');
const { compareCalibration } = require('../lib/cognitive-lab-comparison');
const { comparisonInput, records, budgets } = require('./helpers/cognitive-lab-comparison');

function evaluate(input = comparisonInput(), changes = {}) {
  return compareCalibration({ design: buildComparisonManifest(input), baseline: records(input), candidate: records(input, 0.8), budgets: budgets(input), ...changes });
}

test('paired Brier/ECE deltas are analytic, split-specific, and deterministic', () => {
  const report = evaluate();
  assert.equal(report.status, 'MEASURED');
  assert.equal(report.calibrationComparison, 'MEANINGFUL_IMPROVEMENT');
  for (const split of ['holdout', 'transfer']) {
    assert.equal(report.splits[split].counts.observed, 10);
    assert.equal(report.splits[split].baseline.brier, 0.25);
    assert.ok(Math.abs(report.splits[split].candidate.brier - 0.04) < 1e-12);
    assert.ok(Math.abs(report.splits[split].delta.brier + 0.21) < 1e-12);
    assert.ok(Math.abs(report.splits[split].delta.ece + 0.3) < 1e-12);
    assert.ok(report.splits[split].intervals.brier.upper < -0.01);
  }
  assert.equal(report.assertsGain, false);
  assert.equal(report.intelligenceGain, 'NOT_MEASURED');
  assert.deepEqual(report, evaluate());
});

test('baseline versus itself cannot assert meaningful improvement', () => {
  const input = comparisonInput();
  const report = evaluate(input, { candidate: records(input) });
  assert.equal(report.status, 'MEASURED');
  assert.equal(report.calibrationComparison, 'NO_MEANINGFUL_IMPROVEMENT');
  assert.equal(report.splits.holdout.delta.brier, 0);
});

test('heterogeneous identical forecasts preserve exact zero paired uncertainty', () => {
  const input = comparisonInput();
  const mixed = records(input).map((r, i) => ({ ...r, probability: (i % 10 + 0.5) / 10,
    y: i % 2, outcome: i % 2 ? 'confirmed' : 'incident' }));
  const report = evaluate(input, { baseline: mixed, candidate: structuredClone(mixed).reverse() });
  assert.equal(report.status, 'MEASURED');
  for (const split of ['holdout', 'transfer']) {
    assert.deepEqual(report.splits[split].delta, { brier: 0, ece: 0 });
    assert.deepEqual(report.splits[split].intervals, { brier: { lower: 0, upper: 0 }, ece: { lower: 0, upper: 0 } });
  }
});

test('wrong high probability worsens calibration and fails non-inferiority', () => {
  const input = comparisonInput();
  const adverse = p => records(input, p).map(r => ({ ...r, outcome: 'incident', y: 0 }));
  const report = evaluate(input, { baseline: adverse(0.1), candidate: adverse(0.9) });
  assert.equal(report.calibrationComparison, 'REGRESSION');
  assert.ok(report.splits.holdout.delta.brier > 0.79);
});

test('a censored, missing, or invalid outcome cannot create gain PASS', () => {
  const input = comparisonInput();
  for (const status of ['censored', 'missing', 'measurement_error']) {
    const candidate = records(input, 0.8);
    candidate[0] = { ...candidate[0], status, outcome: null, y: null };
    const report = evaluate(input, { candidate });
    assert.equal(report.status, 'INSUFFICIENT', status);
    assert.equal(report.calibrationComparison, 'NOT_MEASURED');
    assert.equal(report.assertsGain, false);
  }
});

test('a missing probability, a duplicate decision, and a mismatched outcome fail closed', () => {
  const input = comparisonInput();
  assert.equal(evaluate(input, { candidate: records(input).slice(1) }).status, 'INSUFFICIENT');
  const repeated = records(input);
  repeated.push({ ...repeated[0] });
  assert.equal(evaluate(input, { candidate: repeated }).status, 'REJECT');
  const forged = records(input);
  forged[0] = { ...forged[0], outcome: 'incident', y: 0 };
  assert.equal(evaluate(input, { candidate: forged }).status, 'REJECT');
});

test('unknown budget usage, envelope mismatch, and overrun never allow improvement', () => {
  const input = comparisonInput();
  const unknown = budgets(input);
  unknown.candidate.usage.tokens = null;
  assert.equal(evaluate(input, { budgets: unknown }).status, 'INSUFFICIENT');
  const mismatch = budgets(input);
  mismatch.candidate.envelope.tokens += 1;
  assert.equal(evaluate(input, { budgets: mismatch }).status, 'REJECT');
  const excess = budgets(input);
  excess.candidate.usage.tokens = 1001;
  assert.equal(evaluate(input, { budgets: excess }).status, 'REJECT');
  for (const counter of ['tokens', 'humanCalls']) {
    const different = budgets(input);
    different.candidate.usage[counter] += 1;
    const report = evaluate(input, { budgets: different });
    assert.equal(report.status, 'REJECT');
    assert.equal(report.reason, 'budget_mismatch');
  }
});

test('non-finite and out-of-range forecasts are measurement errors, not success', () => {
  const input = comparisonInput();
  for (const probability of [NaN, Infinity, -0.1, 1.1]) {
    const candidate = records(input, 0.8);
    candidate[0].probability = probability;
    assert.equal(evaluate(input, { candidate }).status, 'INSUFFICIENT');
  }
});

test('comparison manifest locks source, split, fixture, thresholds and seed', () => {
  const input = comparisonInput();
  const design = buildComparisonManifest(input);
  assert.equal(Object.isFrozen(design.manifest.protocol.uncertainty), true);
  const reordered = { ...input, tasks: [...input.tasks].reverse() };
  assert.equal(buildComparisonManifest(reordered).digest, design.digest);
  const tampered = JSON.parse(JSON.stringify(design));
  tampered.manifest.protocol.meaningfulEffect = 0;
  assert.throws(() => verifyComparisonManifest(tampered));
});

test('self-consistent malformed manifests, leakage, duplicate events and unlocked thresholds are rejected', () => {
  for (const mutate of [
    input => { input.experiment.extra = true; },
    input => { input.experiment.split.train.push('holdout-0'); },
    input => { input.tasks[0].sourceEventId = input.tasks[1].sourceEventId; },
    input => { input.protocol.meaningfulEffect = NaN; },
    input => { input.protocol.uncertainty.method = 'choose-after-outcome'; },
    input => { input.protocol.bins = [0.5, 1]; input.experiment.thresholdConfigHash = computeManifestDigest(input.protocol); },
    input => { input.experiment.budget.modelCalls = 0.5; },
    input => { input.experiment.thresholdConfigHash = 'a'.repeat(64); },
    input => { input.tasks[0].outcome = 'confirmed'; },
  ]) {
    const input = comparisonInput();
    mutate(input);
    assert.throws(() => buildComparisonManifest(input));
    assert.throws(() => verifyComparisonManifest({ manifest: input, digest: computeManifestDigest(input) }));
  }
});
