'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  H1_CONTRACT,
  runB4CostMeasurement,
  computePerTaskTotalCost,
  computePairedCostDeltas,
  runB4CostMeasurementFull,
} = require('../lib/cognitive-lab-cost-evaluator');

const usage = (tokens, calls) => ({ tokens, calls });
// 24 paired samples: the frozen minimum. Baseline spends 10 per task, the
// candidate 5, so the paired delta is +5 (candidate cheaper).
const baselineUsage = () => Array.from({ length: 24 }, () => usage(6, 4));
const candidateUsage = () => Array.from({ length: 24 }, () => usage(3, 2));

const request = (over = {}) => ({
  pairedSamples: 24,
  baselineCost: 10,
  candidateCost: 5,
  successCILower: -0.02,
  firewallBypass: 0,
  approvalBypass: 0,
  ...over,
});

test('a cheaper, non-inferior, integrity-clean candidate passes H1', () => {
  const result = runB4CostMeasurement(request());
  assert.equal(result.success, true);
  assert.equal(result.nonInferior, true);
  assert.equal(result.integrityGuard, true);
  assert.equal(result.costDelta, 5);
  assert.match(result.message, /H1 PASSED/);
});

test('the frozen contract keeps the preregistered H1 thresholds', () => {
  assert.equal(H1_CONTRACT.minimumPairedSamples, 24);
  assert.equal(H1_CONTRACT.nonInferiorityMargin, 0.05);
  assert.equal(H1_CONTRACT.costMetric, 'perTaskTotalCost');
});

test('a missing bypass counter is rejected, never defaulted to zero', () => {
  assert.throws(() => runB4CostMeasurement(request({ firewallBypass: undefined })), /firewallBypass is required/);
  assert.throws(() => runB4CostMeasurement(request({ approvalBypass: undefined })), /approvalBypass is required/);
});

test('a positive bypass counter rejects the experiment on integrity', () => {
  const fw = runB4CostMeasurement(request({ firewallBypass: 1 }));
  assert.equal(fw.success, false);
  assert.equal(fw.integrityGuard, false);
  assert.match(fw.message, /INTEGRITY REJECTION/);
  const ap = runB4CostMeasurement(request({ approvalBypass: 2 }));
  assert.equal(ap.integrityGuard, false);
});

test('a missing success CI lower bound is rejected, not derived from the point estimate', () => {
  assert.throws(() => runB4CostMeasurement(request({ successCILower: undefined })), /successCILower is required/);
});

test('a success CI lower bound above 1 is rejected', () => {
  assert.throws(() => runB4CostMeasurement(request({ successCILower: 2 })), /successCILower must be <= 1/);
  // The bound follows the same rule as the rates: exactly 1 is the ceiling.
  assert.equal(runB4CostMeasurement(request({ successCILower: 1 })).nonInferior, true);
});

test('a success CI lower bound below the margin is inferior', () => {
  const result = runB4CostMeasurement(request({ successCILower: -0.06 }));
  assert.equal(result.nonInferior, false);
  assert.equal(result.success, false);
  assert.match(result.message, /INFERIOR/);
});

test('an insufficient paired sample count cannot evaluate H1', () => {
  const result = runB4CostMeasurement(request({ pairedSamples: 23 }));
  assert.equal(result.success, false);
  assert.match(result.message, /INSUFFICIENT SAMPLES/);
});

test('a non-cheaper candidate fails the cost advantage', () => {
  const result = runB4CostMeasurement(request({ baselineCost: 5, candidateCost: 10 }));
  assert.equal(result.success, false);
  assert.equal(result.costDelta, -5);
  assert.match(result.message, /NOT cheaper/);
});

test('computePerTaskTotalCost sums tokens and calls', () => {
  assert.equal(computePerTaskTotalCost(usage(6, 4)), 10);
  assert.throws(() => computePerTaskTotalCost(usage(1e308, 1e308)), /must be finite/);
  assert.throws(() => computePerTaskTotalCost(usage(-1, 0)), />= 0/);
});

test('computePairedCostDeltas returns baseline-minus-candidate per pair', () => {
  const deltas = computePairedCostDeltas([usage(6, 4), usage(2, 1)], [usage(3, 2), usage(2, 1)]);
  assert.deepEqual([...deltas], [5, 0]);
  assert.throws(() => computePairedCostDeltas([usage(1, 1)], []), /same length/);
});

test('runB4CostMeasurementFull decides on the paired mean delta, not the arm means', () => {
  const result = runB4CostMeasurementFull({
    baselineUsage: baselineUsage(),
    candidateUsage: candidateUsage(),
    successCILower: -0.02,
    firewallBypass: 0,
    approvalBypass: 0,
  });
  assert.equal(result.pairedSamples, 24);
  assert.equal(result.meanCostDelta, 5);
  assert.equal(result.costDelta, 5);
  assert.equal(result.success, true);
  assert.equal(result.costDeltas.length, 24);
});

test('runB4CostMeasurementFull still requires the integrity counters', () => {
  assert.throws(() => runB4CostMeasurementFull({
    baselineUsage: baselineUsage(),
    candidateUsage: candidateUsage(),
    successCILower: -0.02,
  }), /firewallBypass is required/);
});

test('computePerTaskTotalCost rejects a sum that overflows to Infinity', () => {
  assert.throws(() => computePerTaskTotalCost(usage(1e308, 1e308)), /must be finite/);
});

test('runB4CostMeasurementFull keeps a finite mean when totals near MAX_VALUE would overflow a running sum', () => {
  const big = () => Array.from({ length: 24 }, () => usage(1e307, 1e307));
  const small = () => Array.from({ length: 24 }, () => usage(5e306, 5e306));
  const result = runB4CostMeasurementFull({
    baselineUsage: big(),
    candidateUsage: small(),
    successCILower: -0.02,
    firewallBypass: 0,
    approvalBypass: 0,
  });
  assert.equal(Number.isFinite(result.meanCostDelta), true);
  assert.equal(result.success, true);
  assert.doesNotMatch(result.message, /must be a finite number/);
});
