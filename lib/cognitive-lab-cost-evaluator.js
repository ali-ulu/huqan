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
 * @module cognitive-lab-cost-evaluator
 */

/**
 * Schema version for the cost measurement report.
 * @type {string}
 */
const COST_EVALUATOR_SCHEMA_VERSION = 'huqan-cognitive-lab-cost-evaluator-v1';

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
 * Validates that a value is a boolean.
 * @param {unknown} value - Value to validate
 * @param {string} fieldName - Field name for error messages
 * @returns {boolean} The validated value
 * @throws {TypeError} If value is not a boolean
 */
function validateBoolean(value, fieldName) {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${fieldName} must be a boolean`);
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
 * @param {number} [input.baselineSuccessRate] - Baseline success rate (0-1), optional for cost-only
 * @param {number} [input.candidateSuccessRate] - Candidate success rate (0-1), optional for cost-only
 * @param {number} [input.successCILower] - Lower bound of success rate CI, optional
 * @param {number} [input.firewallBypass=0] - Number of firewall bypasses observed
 * @param {number} [input.approvalBypass=0] - Number of approval bypasses observed
 * @returns {{
 *   success: boolean,
 *   nonInferior: boolean,
 *   costDelta: number,
 *   integrityGuard: boolean,
 *   message: string
 * }} Cost measurement result
 *
 * @throws {TypeError} If input validation fails
 */
function runB4CostMeasurement({
  pairedSamples,
  baselineCost,
  candidateCost,
  baselineSuccessRate,
  candidateSuccessRate,
  successCILower,
  firewallBypass = 0,
  approvalBypass = 0,
} = {}) {
  // Validate required numeric inputs
  const samples = validateNonNegativeInteger(pairedSamples, 'pairedSamples');
  const baseCost = validateNonNegativeNumber(baselineCost, 'baselineCost');
  const candCost = validateNonNegativeNumber(candidateCost, 'candidateCost');

  // Validate optional success rates if provided
  if (baselineSuccessRate !== undefined) {
    validateNonNegativeNumber(baselineSuccessRate, 'baselineSuccessRate');
    if (baselineSuccessRate > 1) throw new TypeError('baselineSuccessRate must be <= 1');
  }
  if (candidateSuccessRate !== undefined) {
    validateNonNegativeNumber(candidateSuccessRate, 'candidateSuccessRate');
    if (candidateSuccessRate > 1) throw new TypeError('candidateSuccessRate must be <= 1');
  }
  if (successCILower !== undefined) {
    if (typeof successCILower !== 'number' || !Number.isFinite(successCILower)) {
      throw new TypeError('successCILower must be a finite number');
    }
  }

  // Validate integrity counters
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

  // Calculate cost delta: positive means candidate is cheaper
  const costDelta = baseCost - candCost;
  const costAdvantage = costDelta > 0;

  // Evaluate non-inferiority if success rates provided
  let nonInferior = true;
  let nonInferiorMessage = '';

  if (successCILower !== undefined) {
    nonInferior = successCILower >= -H1_CONTRACT.nonInferiorityMargin;
    nonInferiorMessage = nonInferior
      ? ` (successCI_Lower=${successCILower.toFixed(4)} >= -${H1_CONTRACT.nonInferiorityMargin}: NON-INFERIOR)`
      : ` (successCI_Lower=${successCILower.toFixed(4)} < -${H1_CONTRACT.nonInferiorityMargin}: INFERIOR)`;
  } else if (baselineSuccessRate !== undefined && candidateSuccessRate !== undefined) {
    // Simple point-estimate check if CI not provided
    const successDelta = candidateSuccessRate - baselineSuccessRate;
    nonInferior = successDelta >= -H1_CONTRACT.nonInferiorityMargin;
    nonInferiorMessage = nonInferior
      ? ` (successDelta=${successDelta.toFixed(4)} >= -${H1_CONTRACT.nonInferiorityMargin}: NON-INFERIOR)`
      : ` (successDelta=${successDelta.toFixed(4)} < -${H1_CONTRACT.nonInferiorityMargin}: INFERIOR)`;
  }

  // Overall success: cost advantage AND non-inferior AND integrity guard
  const success = costAdvantage && nonInferior && integrityGuard;

  let message;
  if (success) {
    message = `H1 PASSED: costDelta=${costDelta.toFixed(4)} (candidate cheaper)${nonInferiorMessage}, integrityGuard=PASS (firewallBypass=0, approvalBypass=0), samples=${samples} >= ${H1_CONTRACT.minimumPairedSamples}.`;
  } else if (!costAdvantage) {
    message = `H1 FAILED: costDelta=${costDelta.toFixed(4)} (candidate NOT cheaper, baselineCost=${baseCost}, candidateCost=${candCost})${nonInferiorMessage}, integrityGuard=PASS.`;
  } else {
    message = `H1 FAILED: costDelta=${costDelta.toFixed(4)}${nonInferiorMessage}, integrityGuard=PASS.`;
  }

  return Object.freeze({
    success,
    nonInferior,
    costDelta,
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
 */
function computePerTaskTotalCost(usage) {
  if (!usage || typeof usage !== 'object') {
    throw new TypeError('usage object required');
  }
  const tokens = validateNonNegativeNumber(usage.tokens, 'usage.tokens');
  const calls = validateNonNegativeNumber(usage.calls, 'usage.calls');
  return tokens + calls;
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
 * @param {number} [input.baselineSuccessRate] - Baseline success rate
 * @param {number} [input.candidateSuccessRate] - Candidate success rate
 * @param {number} [input.successCILower] - Lower bound of success rate CI
 * @param {number} [input.firewallBypass=0] - Firewall bypass count
 * @param {number} [input.approvalBypass=0] - Approval bypass count
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
  baselineSuccessRate,
  candidateSuccessRate,
  successCILower,
  firewallBypass = 0,
  approvalBypass = 0,
} = {}) {
  if (!Array.isArray(baselineUsage) || !Array.isArray(candidateUsage)) {
    throw new TypeError('baselineUsage and candidateUsage arrays required');
  }
  if (baselineUsage.length !== candidateUsage.length) {
    throw new TypeError('baselineUsage and candidateUsage must have same length');
  }

  const pairedSamples = baselineUsage.length;
  const costDeltas = computePairedCostDeltas(baselineUsage, candidateUsage);
  const meanCostDelta = costDeltas.reduce((sum, d) => sum + d, 0) / pairedSamples;

  // Mean baseline and candidate costs
  const meanBaselineCost = baselineUsage.reduce((sum, u) => sum + computePerTaskTotalCost(u), 0) / pairedSamples;
  const meanCandidateCost = candidateUsage.reduce((sum, u) => sum + computePerTaskTotalCost(u), 0) / pairedSamples;

  const result = runB4CostMeasurement({
    pairedSamples,
    baselineCost: meanBaselineCost,
    candidateCost: meanCandidateCost,
    baselineSuccessRate,
    candidateSuccessRate,
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
  COST_EVALUATOR_SCHEMA_VERSION,
  H1_CONTRACT,
  runB4CostMeasurement,
  computePerTaskTotalCost,
  computePairedCostDeltas,
  runB4CostMeasurementFull,
};