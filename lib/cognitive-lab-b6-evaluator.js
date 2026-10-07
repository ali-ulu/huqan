'use strict';

/**
 * B6 equal-budget ablation evaluator (#3311 / #3562, program #3306).
 *
 * This is the measurement #3311's acceptance criterion asks for, lifted out of
 * `test/cognitive-lab-b6-scheduler.test.js` so a lab runner can emit a Cognitive
 * Lab manifest for the B6 mechanism (preregistration §11/§15). The corpus stays
 * in the test harness because building it drives the real AgentV3 loop; this
 * module owns only the frozen contract and the pure, fail-closed evaluator.
 *
 * Conservative about any gain claim, by construction:
 *
 * - The comparison contract (metric, direction, seed, resamples, confidence,
 *   meaningful effect, non-inferiority cost margin, fixed minimum sample and
 *   fixed minimum holdout) is locked before a single outcome is scored; an
 *   unknown or missing field is rejected, so no threshold can be chosen after
 *   seeing the data. The minimums are fixed in the contract, not derived from
 *   the corpus length, so removing a task cannot lower the sample gate.
 * - Every observation is validated: solved must be binary and must agree with
 *   the executed step ids, else the report is REJECT. A gain is asserted only
 *   when the lower bootstrap bound clears the locked meaningful effect, cost is
 *   comparable and non-inferior, and the two arms verifiably spent the same
 *   budget. Too few pairs is INSUFFICIENT; an incomparable cost is never a pass.
 * - The preregistered anti-case criterion (§4/§10) is enforced: if the corpus
 *   no longer contains a task the scheduler hurts, the experiment stops as
 *   INSUFFICIENT rather than reporting a gain from an unresponsive corpus.
 *
 * `authority` is fixed to MODEL_AUTHORITY and `canonical` to false: a verdict
 * here is an experimental ranking, never a promoted rule.
 */

const { createPairedSampler } = require('./cognitive-lab-paired-delta');

// Every field is required and frozen: no default may be chosen at scoring time.
// minimumSamples / minimumHoldout are fixed constants, not corpus length.
const CONTRACT = Object.freeze({
  metric: 'solved-task-rate',
  direction: 'higher-is-better',
  seed: 3311,
  resamples: 2000,
  confidenceLevel: 0.95,
  meaningfulEffect: 0,
  nonInferiorityCostMargin: 0,
  minimumSamples: 16,
  minimumHoldout: 8,
});

const CONTRACT_SPEC = Object.freeze({
  metric: 'string',
  direction: 'literal:higher-is-better',
  seed: 'non-negative-integer',
  resamples: 'integer-at-least-100',
  confidenceLevel: 'unit-open-interval',
  meaningfulEffect: 'non-negative-number',
  nonInferiorityCostMargin: 'non-negative-number',
  minimumSamples: 'integer-at-least-1',
  minimumHoldout: 'integer-at-least-1',
});

// One predicate per numeric kind, looked up rather than chained: adding a kind
// is a table entry, not another branch in a dispatch that grows with it.
const VALIDATORS = Object.freeze({
  'non-negative-integer': (value) => Number.isInteger(value) && value >= 0,
  'integer-at-least-100': (value) => Number.isInteger(value) && value >= 100,
  'integer-at-least-1': (value) => Number.isInteger(value) && value >= 1,
  'unit-open-interval': (value) => typeof value === 'number' && value > 0 && value < 1,
  'non-negative-number': (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0,
});

function lockContract(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('contract is required');
  for (const field of Object.keys(raw)) {
    if (!Object.prototype.hasOwnProperty.call(CONTRACT_SPEC, field)) throw new Error(`unknown contract field ${field}`);
  }
  for (const [field, kind] of Object.entries(CONTRACT_SPEC)) {
    if (!Object.prototype.hasOwnProperty.call(raw, field)) throw new Error(`missing contract field ${field}`);
    const value = raw[field];
    if (kind === 'string') {
      if (typeof value !== 'string' || !value) throw new Error(`${field} must be a non-empty string`);
      continue;
    }
    if (kind.startsWith('literal:')) {
      if (value !== kind.slice('literal:'.length)) throw new Error(`${field} must be ${kind.slice(8)}`);
      continue;
    }
    const valid = VALIDATORS[kind];
    if (!valid || !valid(value)) throw new Error(`${field} must satisfy ${kind}`);
  }
  if (raw.minimumHoldout > raw.minimumSamples) throw new Error('minimumHoldout must not exceed minimumSamples');
  return Object.freeze({ ...raw });
}

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

/**
 * A record is only scorable when its binary outcome agrees with the executed
 * step ids. A missing outcome, a non-binary outcome or a solved flag that
 * contradicts the steps is not a measurement; it is rejected rather than
 * silently scored.
 */
function observationError(record) {
  for (const arm of ['baseline', 'candidate']) {
    const run = record[arm];
    if (!run || !Array.isArray(run.stepIds)) return `missing_${arm}_steps`;
    if (!Number.isInteger(run.steps) || run.steps < 0) return `invalid_${arm}_steps`;
  }
  for (const [flag, arm] of [['solvedBaseline', 'baseline'], ['solvedCandidate', 'candidate']]) {
    const value = record[flag];
    if (value !== 0 && value !== 1) return `invalid_${flag}`;
    const derived = record[arm].stepIds.includes(record.solutionStepId) ? 1 : 0;
    if (value !== derived) return `inconsistent_${flag}`;
  }
  return null;
}

function totalSolved(records, arm) {
  return records.reduce((sum, record) => sum + record[arm === 'baseline' ? 'solvedBaseline' : 'solvedCandidate'], 0);
}

function costPerSolved(records, arm) {
  const solved = totalSolved(records, arm);
  if (solved === 0) return null; // undefined, never treated as 0
  const steps = records.reduce((sum, record) => sum + record[arm].steps, 0);
  return steps / solved;
}

/**
 * Evaluate paired ablation records against the frozen contract.
 *
 * @param {ReadonlyArray<object>} records one observation per task
 * @param {object} rawContract the preregistered contract; re-locked here so a
 *   caller cannot score against a threshold it chose after seeing the data.
 * @param {{budgetEqual?: boolean}} options an override used only by mutation
 *   tests; when omitted the budget equality is derived from the records.
 * @returns {Readonly<object>} a typed report; `assertsGain` is false unless the
 *   lower bootstrap bound clears the effect, cost is non-inferior and both arms
 *   verifiably spent the same budget.
 */
function evaluate(records, rawContract, options = {}) {
  const contract = lockContract(rawContract);
  const ids = records.map((record) => record.taskId);
  if (new Set(ids).size !== ids.length) return { status: 'REJECT', reason: 'duplicated_observation', assertsGain: false };
  for (const record of records) {
    const error = observationError(record);
    if (error) return { status: 'REJECT', reason: error, assertsGain: false };
  }
  const holdout = records.filter((record) => record.split === 'holdout');
  if (records.length < contract.minimumSamples || holdout.length < contract.minimumHoldout) {
    return { status: 'INSUFFICIENT', reason: 'sample_below_minimum', assertsGain: false };
  }
  if (holdout.length === 0) return { status: 'INSUFFICIENT', reason: 'holdout_empty', assertsGain: false };

  const observedBudgetEqual = records.reduce((sum, record) => sum + record.baseline.steps, 0)
    === records.reduce((sum, record) => sum + record.candidate.steps, 0);
  const budgetEqual = options.budgetEqual === undefined ? observedBudgetEqual : options.budgetEqual;

  // §4/§10 anti-case (class iii): the corpus must keep a task the scheduler
  // hurts. With none, the protocol stops the experiment as INSUFFICIENT rather
  // than letting the same corpus report a gain -- otherwise a change that simply
  // never loses could report a win from an unresponsive corpus.
  const helped = records.some((record) => record.solvedCandidate > record.solvedBaseline);
  const hurt = records.some((record) => record.solvedCandidate < record.solvedBaseline);
  if (!(helped && hurt)) {
    return { status: 'INSUFFICIENT', reason: 'no_anticase', budgetEqual, assertsGain: false };
  }

  const deltas = holdout.map((record) => record.solvedCandidate - record.solvedBaseline);
  const mean = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
  const interval = bootstrapInterval(deltas, contract);

  const baselineCost = costPerSolved(holdout, 'baseline');
  const candidateCost = costPerSolved(holdout, 'candidate');
  // An incomparable cost (one arm solved nothing) is not a pass; it is reported
  // as non-inferior false so the gain stays blocked.
  const nonInferiorCost = baselineCost !== null && candidateCost !== null
    && candidateCost <= baselineCost + contract.nonInferiorityCostMargin;
  const clearsEffect = interval.lower > contract.meaningfulEffect;
  const gain = clearsEffect && nonInferiorCost && budgetEqual;

  return {
    status: 'MEASURED',
    holdoutSize: holdout.length,
    solvedBaseline: totalSolved(holdout, 'baseline'),
    solvedCandidate: totalSolved(holdout, 'candidate'),
    mean,
    interval,
    baselineCost,
    candidateCost,
    budgetEqual,
    nonInferiorCost,
    clearsEffect,
    assertsGain: gain,
    reason: gain ? 'paired_gain_measured'
      : (!clearsEffect ? 'interval_below_meaningful_effect'
        : (!nonInferiorCost ? 'cost_non_inferiority_violated' : 'budget_not_verified')),
  };
}

module.exports = {
  CONTRACT,
  CONTRACT_SPEC,
  lockContract,
  bootstrapInterval,
  observationError,
  evaluate,
};
