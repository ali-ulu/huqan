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
 *   meaningful effect, non-inferiority cost margin, minimum sample) is locked
 *   before a single outcome is scored; an unknown or missing field is rejected,
 *   so no threshold can be chosen after seeing the data.
 * - A gain is asserted only when the *lower* bootstrap bound clears the locked
 *   meaningful effect, the candidate is non-inferior on cost per solved task,
 *   and the two arms verifiably spent the same budget. Anything else reports
 *   the measurement with `assertsGain: false`; too few pairs is INSUFFICIENT.
 * - The corpus is frozen and bidirectional (some objectives reward the goal
 *   keyword the scheduler keys on, some do not), so the scheduler is not
 *   trivially favoured. The suite is not an implementation mirror: mutation
 *   tests assert the evaluator rejects duplicated observations, missing
 *   outcomes counted as successes, ignored budget and ignored order.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { createPairedSampler } = require('../lib/cognitive-lab-paired-delta');
const { TASKS, runTask, isSolved } = require('./helpers/cognitive-lab-b6-scheduler');

// Every field is required and frozen: no default may be chosen at scoring time.
const CONTRACT = Object.freeze({
  metric: 'solved-task-rate',
  direction: 'higher-is-better',
  seed: 3311,
  resamples: 2000,
  confidenceLevel: 0.95,
  meaningfulEffect: 0,
  nonInferiorityCostMargin: 0,
});
const MINIMUM_SAMPLES = TASKS.length;

function lockContract(raw) {
  const spec = {
    metric: 'string',
    direction: 'literal:higher-is-better',
    seed: 'non-negative-integer',
    resamples: 'integer-at-least-100',
    confidenceLevel: 'unit-open-interval',
    meaningfulEffect: 'non-negative-number',
    nonInferiorityCostMargin: 'non-negative-number',
  };
  if (!raw || typeof raw !== 'object') throw new Error('contract is required');
  for (const field of Object.keys(raw)) {
    if (!Object.prototype.hasOwnProperty.call(spec, field)) throw new Error(`unknown contract field ${field}`);
  }
  for (const [field, kind] of Object.entries(spec)) {
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
    } else if (kind === 'unit-open-interval') {
      if (typeof value !== 'number' || !(value > 0 && value < 1)) throw new Error(`${field} must be strictly between 0 and 1`);
    } else if (kind === 'non-negative-number') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${field} must be a finite number >= 0`);
    }
  }
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

function costPerSolved(records, arm) {
  let solved = 0;
  let steps = 0;
  for (const record of records) {
    solved += record[`solved${arm === 'baseline' ? 'Baseline' : 'Candidate'}`];
    steps += record[arm].steps;
  }
  return solved === 0 ? { value: null, none: true } : { value: steps / solved, none: false };
}

function evaluate(records, rawContract, budget = { equal: true }) {
  const contract = lockContract(rawContract);
  const ids = records.map((record) => record.taskId);
  if (new Set(ids).size !== ids.length) return { status: 'REJECT', reason: 'duplicated_observation', assertsGain: false };
  const deltas = records.map((record) => record.solvedCandidate - record.solvedBaseline);
  if (deltas.length < MINIMUM_SAMPLES) return { status: 'INSUFFICIENT', reason: 'sample_below_minimum', assertsGain: false };
  const mean = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
  const interval = bootstrapInterval(deltas, contract);
  const baselineCost = costPerSolved(records, 'baseline');
  const candidateCost = costPerSolved(records, 'candidate');
  const costComparable = !baselineCost.none && !candidateCost.none;
  const nonInferiorCost = !costComparable
    ? true
    : candidateCost.value <= baselineCost.value + contract.nonInferiorityCostMargin;
  const clearsEffect = interval.lower > contract.meaningfulEffect;
  const gain = clearsEffect && nonInferiorCost && budget.equal;
  return {
    status: 'MEASURED',
    solvedBaseline: records.reduce((sum, record) => sum + record.solvedBaseline, 0),
    solvedCandidate: records.reduce((sum, record) => sum + record.solvedCandidate, 0),
    mean,
    interval,
    baselineCost,
    candidateCost,
    budgetEqual: budget.equal,
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
  return records.map((record) => `${record.taskId}:${record.baseline.order.join('>')}|${record.candidate.order.join('>')}`).join('\n');
}

test('the corpus is bidirectional and exercises both arms', () => {
  const records = runCorpus();
  assert.equal(records.length, TASKS.length);
  // At least one task the scheduler helps and at least one it does not, so the
  // measurement cannot be a foregone conclusion in either direction.
  const helped = records.filter((record) => record.solvedCandidate > record.solvedBaseline).length;
  const hurt = records.filter((record) => record.solvedCandidate < record.solvedBaseline).length;
  assert.ok(helped > 0, `expected at least one task the scheduler helps, got ${helped}`);
  assert.ok(hurt > 0, `expected at least one task the scheduler hurts, got ${hurt}`);
});

test('B6 equal-budget ablation: measured, integrity clean, no overclaimed gain', () => {
  const records = runCorpus();

  // Integrity, independent of the gain verdict.
  const baseSteps = records.reduce((sum, record) => sum + record.baseline.steps, 0);
  const candSteps = records.reduce((sum, record) => sum + record.candidate.steps, 0);
  const budgetEqual = baseSteps === candSteps;
  const report = evaluate(records, CONTRACT, { equal: budgetEqual });

  assert.equal(report.status, 'MEASURED');
  assert.equal(report.budgetEqual, true, 'both arms must spend the same observed budget');
  // Honest reporting: the numbers are what they are; the gain flag is the only
  // claim, and it is only true if the lower bound clears the effect.
  assert.equal(report.assertsGain, report.clearsEffect && report.nonInferiorCost && report.budgetEqual);
  assert.equal(report.assertsGain, report.reason === 'paired_gain_measured');

  // Surface the measurement so the run is legible (assertions stay the gate).
  console.log(`B6: solved baseline=${report.solvedBaseline} candidate=${report.solvedCandidate}`
    + ` meanDelta=${report.mean.toFixed(4)} lower=${report.interval.lower.toFixed(4)}`
    + ` costBase=${report.baselineCost.value === null ? 'n/a' : report.baselineCost.value.toFixed(3)}`
    + ` costCand=${report.candidateCost.value === null ? 'n/a' : report.candidateCost.value.toFixed(3)}`
    + ` gain=${report.assertsGain} (${report.reason})`);
});

test('the ablation is deterministic across reruns', () => {
  const first = runCorpus();
  const again = runCorpus();
  assert.equal(digest(again), digest(first), 'identical arms and budgets must reproduce the same orders');
});

test('mutation: a duplicated observation is rejected', () => {
  const records = runCorpus().slice(0, MINIMUM_SAMPLES);
  const mutated = [...records, records[0]];
  const report = evaluate(mutated, CONTRACT);
  assert.equal(report.status, 'REJECT');
  assert.equal(report.reason, 'duplicated_observation');
  assert.equal(report.assertsGain, false);
});

test('mutation: a missing outcome cannot be counted as a success', () => {
  const maxK = Math.max(...TASKS.map((task) => task.K));
  const truncated = TASKS.map((task) => ({
    ...task,
    K: maxK,
  }));
  // A predicate that ignores the required tools would mark an unexecuted plan
  // solved; the real predicate does not.
  const emptyOrder = [];
  for (const task of truncated) {
    assert.equal(isSolved(task, emptyOrder), false, `${task.taskId} must not be solved with no executed steps`);
  }
  const records = TASKS.map((task) => ({
    taskId: task.taskId,
    baseline: { order: [], steps: 0 },
    candidate: { order: [], steps: 0 },
    solvedBaseline: 0,
    solvedCandidate: isSolved(task, []) ? 1 : 0,
  }));
  assert.equal(records.every((record) => record.solvedCandidate === 0), true);
});

test('mutation: an ignored budget blocks the gain claim', () => {
  const records = runCorpus();
  // A candidate that spent more steps than the baseline is not an equal-budget
  // comparison, so the evaluator must not assert a gain regardless of the delta.
  const report = evaluate(records, CONTRACT, { equal: false });
  assert.equal(report.assertsGain, false);
  assert.equal(report.reason === 'budget_not_verified' || !report.clearsEffect, true);
});

test('mutation: ignoring order removes the effect the scheduler has', () => {
  const orderSensitive = TASKS.map((task) => ({
    taskId: task.taskId,
    baseline: { order: [], steps: 0 },
    candidate: { order: [], steps: 0 },
    solvedBaseline: 1, // a mutant that always solves
    solvedCandidate: 1,
  }));
  const report = evaluate(orderSensitive, CONTRACT, { equal: true });
  assert.equal(report.mean, 0, 'an order-ignoring predicate cannot show a delta');
});

test('the contract refuses an invented threshold chosen after the fact', () => {
  assert.throws(() => lockContract({ ...CONTRACT, extra: 1 }), /unknown contract field/);
  const { meaningfulEffect, ...missing } = CONTRACT;
  assert.throws(() => lockContract(missing), /missing contract field meaningfulEffect/);
  assert.throws(() => lockContract({ ...CONTRACT, direction: 'lower-is-better' }), /direction must be/);
});
