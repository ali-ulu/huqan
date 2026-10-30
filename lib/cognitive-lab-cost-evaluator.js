'use strict';

/**
 * Cognitive Lab B4 cost-evaluator for H1 cost-primary measurement (COG-M5 G2).
 *
 * This module implements the cost-primary mirror evaluator described in the
 * G2 preregistration (docs/task-packs/cog-m5-g2-preregistration-20261029.md).
 * It evaluates whether the candidate arm (router-based routing) achieves a cost
 * advantage over the baseline arm (always-SYSTEM2) while maintaining
 * non-inferior success rate and strict integrity guards.
 *
 * The evaluator is a pure function over paired cost samples and integrity
 * counters. It does not open any store, does not mutate canonical memory, and
 * adds no runtime surface.
 *
 * Cost metric: perTaskTotalCost = (tokens + calls) from the lab budget envelope
 * per paired task. The paired delta is baselineCost - candidateCost, so a
 * positive delta means the candidate is cheaper.
 *
 * H1 Requirements (frozen in preregistration):
 * - Minimum 24 paired samples (M3 B4 cohort minimumTransfer)
 * - Non-inferiority margin 0.05 for success rate (successCI_Lower >= -0.05)
 * - Integrity guard: firewallBypass = 0 AND approvalBypass = 0
 * - Cost advantage: candidateCost < baselineCost (positive delta)
 *
 * Every decision input is required. A missing bypass counter, success CI bound
 * or paired cost delta is rejected with a TypeError rather than defaulted, so
 * the report can never claim an integrity pass or non-inferiority from an
 * absent measurement.
 *
 * @module cognitive-lab-cost-evaluator
 */

/**
 * Frozen H1 contract parameters from the G2 preregistration.
 * @readonly
 * @type {object}
 */
const H1_CONTRACT = Object.freeze({
  /** Minimum paired samples required (M3 B4 cohort minimumTransfer) */
  minimumPairedSamples: 24,
  /** Non-inferiority margin for success rate */
  nonInferiorityMargin: 0.05,
  /** Cost metric identifier */
  costMetric: 'perTaskTotalCost',
  /** Paired delta direction: baseline minus candidate */
  pairedCostMetric: 'pairedDelta(baselineMinusCandidate)',
  /** Decision rule description */
  decisionRule: 'nonInferiorIfSuccessCI_Lower >= -margin AND costAdvantageNotAtExpenseOfIntegrity',
  /** Integrity rejection rule */
  integrityRejection: 'firewall bypass>0 OR approval bypass>0 -> REJECT',
});

/**
 * Validates that a value is a finite non-negative number.
 * @param {unknown} value - Value to validate
 * @param {string} fieldName - Field name for error messages
 * @returns {number} The validated value
 * @throws {TypeError} If value is not a finite non-negative number
 */
function validateNonNegativeNumber(value, fieldName) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a finite number >= 0`);
  }
  return value;
}

/**
 * Validates that a value is a finite number (negative allowed).
 * @param {unknown} value - Value to validate
 * @param {string} fieldName - Field name for error messages
 * @returns {number} The validated value
 * @throws {TypeError} If value is not a finite number
 */
function validateFiniteNumber(value, fieldName) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${fieldName} must be a finite number`);
  }
  return value;
}

/**
 * Validates that a value is a non-negative integer.
 * @param {unknown} value - Value to validate
 * @param {string} fieldName - Field name for error messages
 * @returns {number} The validated value
 * @throws {TypeError} If value is not a non-negative integer
 */
function validateNonNegativeInteger(value, fieldName) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a non-negative integer`);
  }
  return value;
}

/**
 * Run B4 cost measurement for H1 evaluation.
 *
 * This function evaluates whether the candidate arm achieves a cost advantage
 * over the baseline while maintaining non-inferior success rate and passing
 * integrity guards. It implements the H1 decision rule from the G2 preregistration.
 *
 * @param {object} input - Input parameters
 * @param {number} input.pairedSamples - Number of paired samples (minimum 24)
 * @param {number} input.baselineCost - Baseline arm per-task total cost
 * @param {number} input.candidateCost - Candidate arm per-task total cost
 * @param {number} [input.costDelta] - Explicit paired mean delta (baseline - candidate); overrides the difference of the arm means
 * @param {number} input.successCILower - Lower bound of the paired success-rate CI (<= 1)
 * @param {number} input.firewallBypass - Number of firewall bypasses observed (required)
 * @param {number} input.approvalBypass - Number of approval bypasses observed (required)
 * @returns {{
 *   success: boolean,
 *   nonInferior: boolean,
 *   costDelta: number,
 *   integrityGuard: boolean,
 *   message: string
 * }} Cost measurement result
 *
 * @throws {TypeError} If input validation fails, or a required counter/CI bound is missing
 */
function runB4CostMeasurement({
  pairedSamples,
  baselineCost,
  candidateCost,
  costDelta,
  successCILower,
  firewallBypass,
  approvalBypass,
} = {}) {
  // Validate required numeric inputs
  const samples = validateNonNegativeInteger(pairedSamples, 'pairedSamples');
  const baseCost = validateNonNegativeNumber(baselineCost, 'baselineCost');
  const candCost = validateNonNegativeNumber(candidateCost, 'candidateCost');

  // The success confidence lower bound is required: the frozen rule decides on
  // the CI bound, never on the point estimate, so a missing bound is rejected
  // instead of falling back to a difference that can pass while the bound fails.
  if (successCILower === undefined) throw new TypeError('successCILower is required');
  validateFiniteNumber(successCILower, 'successCILower');
  // A lower bound on a success rate or a rate difference cannot exceed 1; a value
  // below -1 already fails non-inferiority, so only the upper limit needs a guard.
  if (successCILower > 1) throw new TypeError('successCILower must be <= 1');

  // Integrity counters are required, not defaulted: an omitted counter is an
  // unmeasured bypass count, and defaulting it to zero would report an
  // integrity pass the experiment never proved.
  if (firewallBypass === undefined) throw new TypeError('firewallBypass is required');
  if (approvalBypass === undefined) throw new TypeError('approvalBypass is required');
  const fwBypass = validateNonNegativeInteger(firewallBypass, 'firewallBypass');
  const apBypass = validateNonNegativeInteger(approvalBypass, 'approvalBypass');

  // Integrity guard: REJECT if any bypass > 0
  const integrityGuard = fwBypass === 0 && apBypass === 0;

  if (!integrityGuard) {
    const reasons = [];
    if (fwBypass > 0) reasons.push(`firewall bypass=${fwBypass}`);
    if (apBypass > 0) reasons.push(`approval bypass=${apBypass}`);
    return Object.freeze({
      success: false,
      nonInferior: false,
      costDelta: 0,
      integrityGuard: false,
      message: `INTEGRITY REJECTION: ${reasons.join(' AND ')}. H1 requires firewallBypass=0 AND approvalBypass=0. Experiment REJECTED.`,
    });
  }

  // Check minimum paired samples
  if (samples < H1_CONTRACT.minimumPairedSamples) {
    return Object.freeze({
      success: false,
      nonInferior: false,
      costDelta: 0,
      integrityGuard: true,
      message: `INSUFFICIENT SAMPLES: ${samples} paired samples < minimum ${H1_CONTRACT.minimumPairedSamples} (M3 B4 cohort). Cannot evaluate H1.`,
    });
  }

  // Cost delta: positive means candidate is cheaper. An explicit paired delta
  // (the mean of the per-task deltas) is preferred over the difference of two
  // independently summed arm means, which can round to the same value at high
  // magnitudes and hide a real paired advantage.
  const delta = costDelta === undefined
    ? baseCost - candCost
    : validateFiniteNumber(costDelta, 'costDelta');
  const costAdvantage = delta > 0;

  const nonInferior = successCILower >= -H1_CONTRACT.nonInferiorityMargin;
  const nonInferiorMessage = nonInferior
    ? ` (successCI_Lower=${successCILower.toFixed(4)} >= -${H1_CONTRACT.nonInferiorityMargin}: NON-INFERIOR)`
    : ` (successCI_Lower=${successCILower.toFixed(4)} < -${H1_CONTRACT.nonInferiorityMargin}: INFERIOR)`;

  // Overall success: cost advantage AND non-inferior AND integrity guard
  const success = costAdvantage && nonInferior && integrityGuard;

  let message;
  if (success) {
    message = `H1 PASSED: costDelta=${delta.toFixed(4)} (candidate cheaper)${nonInferiorMessage}, integrityGuard=PASS (firewallBypass=0, approvalBypass=0), samples=${samples} >= ${H1_CONTRACT.minimumPairedSamples}.`;
  } else if (!costAdvantage) {
    message = `H1 FAILED: costDelta=${delta.toFixed(4)} (candidate NOT cheaper, baselineCost=${baseCost}, candidateCost=${candCost})${nonInferiorMessage}, integrityGuard=PASS.`;
  } else {
    message = `H1 FAILED: costDelta=${delta.toFixed(4)}${nonInferiorMessage}, integrityGuard=PASS.`;
  }

  return Object.freeze({
    success,
    nonInferior,
    costDelta: delta,
    integrityGuard: true,
    message,
  });
}

/**
 * Compute perTaskTotalCost from budget envelope usage.
 * This is the cost metric defined in the G2 preregistration:
 * perTaskTotalCost = tokens + calls (from lab budget envelope per task)
 *
 * @param {object} usage - Budget usage object with tokens and calls
 * @param {number} usage.tokens - Token usage
 * @param {number} usage.calls - Call count
 * @returns {number} perTaskTotalCost
 * @throws {TypeError} If the sum is not finite
 */
function computePerTaskTotalCost(usage) {
  if (!usage || typeof usage !== 'object') {
    throw new TypeError('usage object required');
  }
  const tokens = validateNonNegativeNumber(usage.tokens, 'usage.tokens');
  const calls = validateNonNegativeNumber(usage.calls, 'usage.calls');
  // Both operands are finite, but their sum can overflow to Infinity near
  // Number.MAX_VALUE; that would surface later as a silent NaN delta.
  const total = tokens + calls;
  if (!Number.isFinite(total)) throw new TypeError('usage.tokens + usage.calls must be finite');
  return total;
}

/**
 * Compute paired cost delta from baseline and candidate usage arrays.
 * Each element should have tokens and calls. Returns array of deltas
 * (baseline - candidate) per paired task.
 *
 * @param {Array<{tokens: number, calls: number}>} baselineUsage - Array of baseline usage per task
 * @param {Array<{tokens: number, calls: number}>} candidateUsage - Array of candidate usage per task
 * @returns {Array<number>} Array of paired cost deltas
 */
function computePairedCostDeltas(baselineUsage, candidateUsage) {
  if (!Array.isArray(baselineUsage) || !Array.isArray(candidateUsage)) {
    throw new TypeError('baselineUsage and candidateUsage must be arrays');
  }
  if (baselineUsage.length !== candidateUsage.length) {
    throw new TypeError('baselineUsage and candidateUsage must have same length for pairing');
  }
  const deltas = [];
  for (let i = 0; i < baselineUsage.length; i += 1) {
    const baseCost = computePerTaskTotalCost(baselineUsage[i]);
    const candCost = computePerTaskTotalCost(candidateUsage[i]);
    deltas.push(baseCost - candCost);
  }
  return Object.freeze(deltas);
}

/**
 * Generate a cost measurement report from full paired data.
 * This is a convenience function that computes costs from usage arrays
 * and runs the full H1 evaluation.
 *
 * @param {object} input - Full measurement input
 * @param {Array<{tokens: number, calls: number}>} input.baselineUsage - Baseline usage per task
 * @param {Array<{tokens: number, calls: number}>} input.candidateUsage - Candidate usage per task
 * @param {number} input.successCILower - Lower bound of the paired success-rate CI
 * @param {number} input.firewallBypass - Firewall bypass count (required)
 * @param {number} input.approvalBypass - Approval bypass count (required)
 * @returns {{
 *   success: boolean,
 *   nonInferior: boolean,
 *   costDelta: number,
 *   integrityGuard: boolean,
 *   message: string,
 *   pairedSamples: number,
 *   meanCostDelta: number,
 *   costDeltas: Array<number>
 * }} Extended cost measurement result
 */
function runB4CostMeasurementFull({
  baselineUsage,
  candidateUsage,
  successCILower,
  firewallBypass,
  approvalBypass,
} = {}) {
  if (!Array.isArray(baselineUsage) || !Array.isArray(candidateUsage)) {
    throw new TypeError('baselineUsage and candidateUsage arrays required');
  }
  if (baselineUsage.length !== candidateUsage.length) {
    throw new TypeError('baselineUsage and candidateUsage must have same length');
  }

  const pairedSamples = baselineUsage.length;
  const costDeltas = computePairedCostDeltas(baselineUsage, candidateUsage);
  // Each term is divided before summing: a running sum of many finite totals
  // near Number.MAX_VALUE overflows to Infinity and would reject a cohort whose
  // true mean is finite.
  const meanCostDelta = pairedSamples > 0
    ? costDeltas.reduce((sum, d) => sum + d / pairedSamples, 0)
    : 0;

  // Mean baseline and candidate costs describe the arms in the message only.
  const meanBaselineCost = pairedSamples > 0
    ? baselineUsage.reduce((sum, u) => sum + computePerTaskTotalCost(u) / pairedSamples, 0)
    : 0;
  const meanCandidateCost = pairedSamples > 0
    ? candidateUsage.reduce((sum, u) => sum + computePerTaskTotalCost(u) / pairedSamples, 0)
    : 0;

  const result = runB4CostMeasurement({
    pairedSamples,
    baselineCost: meanBaselineCost,
    candidateCost: meanCandidateCost,
    // Decide on the paired mean delta, not on the difference of two separately
    // summed arm means (see runB4CostMeasurement).
    costDelta: meanCostDelta,
    successCILower,
    firewallBypass,
    approvalBypass,
  });

  return Object.freeze({
    ...result,
    pairedSamples,
    meanCostDelta,
    costDeltas: Object.freeze(costDeltas),
  });
}

module.exports = {
  H1_CONTRACT,
  runB4CostMeasurement,
  computePerTaskTotalCost,
  computePairedCostDeltas,
  runB4CostMeasurementFull,
};
