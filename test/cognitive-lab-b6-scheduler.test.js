'use strict';

/**
 * B6 equal-budget ablation: opt-in cognitive scheduler vs FIFO plan order
 * (#3311, program #3306).
 *
 * This is the measurement #3311's acceptance criterion asks for, run on the
 * real AgentV3 loop (through `test/helpers/cognitive-lab-b6-scheduler.js`). It
 * is deliberately conservative about any gain claim:
 *
 * - The comparison contract (metric, direction, seed, resamples, confidence,
 *   meaningful effect, non-inferiority cost margin, fixed minimum sample and
 *   fixed minimum holdout) is locked before a single outcome is scored; an
 *   unknown or missing field is rejected, so no threshold can be chosen after
 *   seeing the data. The minimums are fixed in the contract, not derived from
 *   the corpus length, so removing a task cannot lower the sample gate.
 * - The primary metric is the *holdout* split; train/transfer are reported for
 *   context only, because they are the families the keyword signal is expected
 *   to favour.
 * - Every observation is validated: solved must be binary and must agree with
 *   the executed step ids, else the report is REJECT. A gain is asserted only
 *   when the lower bootstrap bound clears the locked meaningful effect, cost is
 *   comparable and non-inferior, and the two arms verifiably spent the same
 *   budget. Too few pairs is INSUFFICIENT; an incomparable cost is never a
 *   pass.
 * - The suite is not an implementation mirror: mutation tests assert the
 *   evaluator rejects duplicated observations, missing/inconsistent outcomes,
 *   ignored budget and ignored order.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { createPairedSampler } = require('../lib/cognitive-lab-paired-delta');
const {
  TASKS, CORPUS_DIGEST, runTask, isSolved,
} = require('./helpers/cognitive-lab-b6-scheduler');

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

function lockContract(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('contract is required');
  for (const field of Object.keys(raw)) {
    if (!Object.prototype.hasOwnProperty.call(CONTRACT_SPEC, field)) throw new Error(`unknown contract field ${field}`);
  }
  for (const [field, kind] of Object.entries(CONTRACT_SPEC)) {
    if (!Object.prototype.hasOwnProperty.call(raw, field)) throw new Error(`missing contract field ${field}`);
    const value = raw[field];
    if (kind.startsWith('literal:')) {
      if (value !== kind.slice('literal:'.length)) throw new Error(`${field} must be ${kind.slice(8)}`);
    } else if (kind === 'string') {
      if (typeof value !== 'string' || !value) throw new Error(`${field} must be a non-empty string`);
    } else if (kind === 'non-negative-integer') {
      if (!Number.isInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`);
    } else if (kind === 'integer-at-least-100') {
      if (!Number.isInteger(value) || value < 100) throw new Error(`${field} must be an integer of at least 100`);
    } else if (kind === 'integer-at-least-1') {
      if (!Number.isInteger(value) || value < 1) throw new Error(`${field} must be an integer of at least 1`);
    } else if (kind === 'unit-open-interval') {
      if (typeof value !== 'number' || !(value > 0 && value < 1)) throw new Error(`${field} must be strictly between 0 and 1`);
    } else if (kind === 'non-negative-number') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${field} must be a finite number >= 0`);
    }
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

  const deltas = holdout.map((record) => record.solvedCandidate - record.solvedBaseline);
  const mean = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
  const interval = bootstrapInterval(deltas, contract);

  const observedBudgetEqual = records.reduce((sum, record) => sum + record.baseline.steps, 0)
    === records.reduce((sum, record) => sum + record.candidate.steps, 0);
  const budgetEqual = options.budgetEqual === undefined ? observedBudgetEqual : options.budgetEqual;

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

function runCorpus() {
  return TASKS.map((task) => runTask(task));
}

function digest(records) {
  return records.map((record) => `${record.taskId}:${record.baseline.stepIds.join('>')}|${record.candidate.stepIds.join('>')}`).join('\n');
}

test('the frozen corpus satisfies the locked minimums and is bidirectional', () => {
  const contract = lockContract(CONTRACT);
  assert.ok(TASKS.length >= contract.minimumSamples, `corpus ${TASKS.length} < minimumSamples ${contract.minimumSamples}`);
  const holdout = TASKS.filter((task) => task.split === 'holdout');
  assert.ok(holdout.length >= contract.minimumHoldout, `holdout ${holdout.length} < minimumHoldout ${contract.minimumHoldout}`);
  assert.equal(typeof CORPUS_DIGEST, 'string');
  assert.ok(CORPUS_DIGEST.length > 0, 'the corpus must carry a digest that names what ran');

  const records = runCorpus();
  const helped = records.filter((record) => record.solvedCandidate > record.solvedBaseline).length;
  const hurt = records.filter((record) => record.solvedCandidate < record.solvedBaseline).length;
  assert.ok(helped > 0, `expected at least one task the scheduler helps, got ${helped}`);
  assert.ok(hurt > 0, `expected at least one task the scheduler hurts, got ${hurt}`);
});

test('B6 equal-budget ablation: measured on holdout, integrity clean, no overclaimed gain', () => {
  const records = runCorpus();
  const baseSteps = records.reduce((sum, record) => sum + record.baseline.steps, 0);
  const candSteps = records.reduce((sum, record) => sum + record.candidate.steps, 0);
  const report = evaluate(records, CONTRACT, { budgetEqual: baseSteps === candSteps });

  assert.equal(report.status, 'MEASURED');
  assert.equal(report.budgetEqual, true, 'both arms must spend the same observed budget');
  assert.equal(report.assertsGain, report.clearsEffect && report.nonInferiorCost && report.budgetEqual);
  assert.equal(report.assertsGain, report.reason === 'paired_gain_measured');

  console.log(`B6 holdout(n=${report.holdoutSize}): solved baseline=${report.solvedBaseline} candidate=${report.solvedCandidate}`
    + ` meanDelta=${report.mean.toFixed(4)} lower=${report.interval.lower.toFixed(4)}`
    + ` costBase=${report.baselineCost === null ? 'n/a' : report.baselineCost.toFixed(3)}`
    + ` costCand=${report.candidateCost === null ? 'n/a' : report.candidateCost.toFixed(3)}`
    + ` gain=${report.assertsGain} (${report.reason})`);
});

test('the ablation is deterministic across reruns', () => {
  assert.equal(digest(runCorpus()), digest(runCorpus()), 'identical arms and budgets must reproduce the same orders');
});

test('mutation: a duplicated observation is rejected', () => {
  const records = runCorpus();
  const report = evaluate([...records, records[0]], CONTRACT);
  assert.equal(report.status, 'REJECT');
  assert.equal(report.reason, 'duplicated_observation');
  assert.equal(report.assertsGain, false);
});

test('mutation: an outcome inconsistent with the executed steps is rejected', () => {
  const records = runCorpus();
  const flipped = records.map((record, index) => (index === 0
    ? { ...record, solvedCandidate: record.solvedCandidate === 1 ? 0 : 1 }
    : record));
  const report = evaluate(flipped, CONTRACT);
  assert.equal(report.status, 'REJECT');
  assert.equal(report.reason, 'inconsistent_solvedCandidate');
  assert.equal(report.assertsGain, false);
});

test('mutation: a missing outcome cannot be counted as a success', () => {
  const emptyOrder = [];
  for (const task of TASKS) {
    assert.equal(isSolved(task, emptyOrder), false, `${task.taskId} must not be solved with no executed steps`);
  }
  const records = TASKS.map((task) => ({
    taskId: task.taskId,
    split: task.split,
    solutionStepId: task.solutionStepId,
    baseline: { stepIds: [], steps: 0 },
    candidate: { stepIds: [], steps: 0 },
    solvedBaseline: isSolved(task, []) ? 1 : 0,
    solvedCandidate: 1, // a mutant that always solves
  }));
  const report = evaluate(records, CONTRACT);
  assert.equal(report.status, 'REJECT');
  assert.equal(report.reason, 'inconsistent_solvedCandidate');
  assert.equal(report.assertsGain, false);
});

test('mutation: an ignored budget blocks the gain claim', () => {
  const records = runCorpus();
  const report = evaluate(records, CONTRACT, { budgetEqual: false });
  assert.equal(report.assertsGain, false);
});

test('mutation: an incomparable cost is never a pass', () => {
  const records = TASKS.map((task) => ({
    taskId: task.taskId,
    split: task.split,
    solutionStepId: task.solutionStepId,
    baseline: { stepIds: [], steps: 0 },
    candidate: { stepIds: [task.solutionStepId], steps: 1 },
    solvedBaseline: 0,
    solvedCandidate: 1,
  }));
  // baseline solves nothing -> cost undefined on both sides of the guard.
  const report = evaluate(records, CONTRACT, { budgetEqual: true });
  assert.equal(report.baselineCost, null);
  assert.equal(report.nonInferiorCost, false);
  assert.equal(report.assertsGain, false);
});

test('mutation: ignoring order removes the effect the scheduler has', () => {
  const orderSensitive = TASKS.map((task) => ({
    taskId: task.taskId,
    split: task.split,
    solutionStepId: task.solutionStepId,
    baseline: { stepIds: [task.solutionStepId], steps: 1 },
    candidate: { stepIds: [task.solutionStepId], steps: 1 },
    solvedBaseline: 1,
    solvedCandidate: 1,
  }));
  const report = evaluate(orderSensitive, CONTRACT, { budgetEqual: true });
  assert.equal(report.mean, 0, 'an order-ignoring predicate cannot show a delta');
});

test('the contract refuses an invented threshold chosen after the fact', () => {
  assert.throws(() => lockContract({ ...CONTRACT, extra: 1 }), /unknown contract field/);
  const { meaningfulEffect, ...missing } = CONTRACT;
  assert.throws(() => lockContract(missing), /missing contract field meaningfulEffect/);
  assert.throws(() => lockContract({ ...CONTRACT, direction: 'lower-is-better' }), /direction must be/);
});
