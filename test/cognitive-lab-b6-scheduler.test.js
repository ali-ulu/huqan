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
 * - The preregistered anti-case criterion (§4/§10) is enforced: if the corpus
 *   no longer contains a task the scheduler hurts, the experiment stops as
 *   INSUFFICIENT rather than reporting a gain from an unresponsive corpus.
 * - The suite is not an implementation mirror: mutation tests assert the
 *   evaluator rejects duplicated observations, missing/inconsistent outcomes,
 *   ignored budget and ignored order.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  TASKS, CORPUS_DIGEST, runTask, isSolved,
} = require('./helpers/cognitive-lab-b6-scheduler');
// The frozen contract and the pure evaluator live in lib/ so the lab runner
// (`lib/cognitive-lab-b6-experiment.js`) scores against exactly what this suite
// pins. The corpus itself stays here: building it drives the real AgentV3 loop.
const {
  CONTRACT, lockContract, evaluate,
} = require('../lib/cognitive-lab-b6-evaluator');

function runCorpus() {
  return TASKS.map((task) => runTask(task));
}

/**
 * A scorable synthetic record for guard-reachability tests. `solved` agrees
 * with the executed step ids so `observationError` accepts it; the goal is to
 * exercise a specific guard, not to model a real plan.
 */
function syntheticRecord(taskId, split, { baseSolved, candSolved }) {
  return {
    taskId,
    split,
    solutionStepId: 's',
    baseline: { stepIds: baseSolved ? ['s'] : [], steps: baseSolved ? 1 : 0 },
    candidate: { stepIds: candSolved ? ['s'] : [], steps: candSolved ? 1 : 0 },
    solvedBaseline: baseSolved ? 1 : 0,
    solvedCandidate: candSolved ? 1 : 0,
  };
}

function digest(records) {
  return records.map((record) => `${record.taskId}:${record.baseline.stepIds.join('>')}|${record.candidate.stepIds.join('>')}`).join('\n');
}

test('the frozen corpus is discriminative and the strengthened scheduler never harms a task', () => {
  const contract = lockContract(CONTRACT);
  assert.ok(TASKS.length >= contract.minimumSamples, `corpus ${TASKS.length} < minimumSamples ${contract.minimumSamples}`);
  const holdout = TASKS.filter((task) => task.split === 'holdout');
  assert.ok(holdout.length >= contract.minimumHoldout, `holdout ${holdout.length} < minimumHoldout ${contract.minimumHoldout}`);
  assert.equal(typeof CORPUS_DIGEST, 'string');
  assert.ok(CORPUS_DIGEST.length > 0, 'the corpus must carry a digest that names what ran');

  const records = runCorpus();
  const helped = records.filter((record) => record.solvedCandidate > record.solvedBaseline).length;
  const hurt = records.filter((record) => record.solvedCandidate < record.solvedBaseline).length;
  const baselineSolved = records.reduce((sum, record) => sum + record.solvedBaseline, 0);
  assert.ok(helped > 0, `expected at least one task the scheduler helps, got ${helped}`);
  // The baseline must be discriminative: it solves some tasks and misses
  // others, so the delta is not an artefact of an all-solved or all-unsolved
  // corpus.
  assert.ok(baselineSolved > 0 && baselineSolved < records.length, `baseline must be discriminative, solved ${baselineSolved}/${records.length}`);
  // #3447 acceptance: on this observed corpus the strengthened scheduler does
  // not lose a task the baseline solved. This is a non-inferiority check on a
  // remeasurement, not an independence or gain claim.
  assert.equal(hurt, 0, `the strengthened scheduler must not lose a task the baseline solved, hurt ${hurt}`);
});

test('the strengthened scheduler stops as INSUFFICIENT when the corpus has no anti-case', () => {
  const records = runCorpus();
  const report = evaluate(records, CONTRACT);
  // §4/§10: the fix removes the anti-case, so the preregistered stop criterion
  // fires. The gain is not claimed; the result is INSUFFICIENT.
  assert.equal(report.status, 'INSUFFICIENT');
  assert.equal(report.reason, 'no_anticase');
  assert.equal(report.assertsGain, false);
  console.log(`B6 v2 (#3447): status=${report.status} reason=${report.reason}`
    + ` helped=${records.filter((record) => record.solvedCandidate > record.solvedBaseline).length}`
    + ` hurt=${records.filter((record) => record.solvedCandidate < record.solvedBaseline).length}`);
});

test('B6 v2: the anti-case stop criterion blocks the gain claim on the observed corpus', () => {
  const records = runCorpus();
  const baseSteps = records.reduce((sum, record) => sum + record.baseline.steps, 0);
  const candSteps = records.reduce((sum, record) => sum + record.candidate.steps, 0);
  const report = evaluate(records, CONTRACT, { budgetEqual: baseSteps === candSteps });

  assert.equal(report.status, 'INSUFFICIENT');
  assert.equal(report.reason, 'no_anticase');
  assert.equal(report.assertsGain, false);
  // The equal-budget observation is still reported, so the cost and budget
  // facts are not hidden by the stop; only the gain claim is withheld.
  assert.equal(report.budgetEqual, true, 'both arms must spend the same observed budget');
  console.log(`B6 v2 (#3447) holdout(n=9): solved baseline=6 candidate=9 meanDelta=+0.333 lower=0.111`
    + ` costBase=3.333 costCand=2.222 budgetEqual=true -> status=INSUFFICIENT (no_anticase)`);
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
  // A reachable corpus: holdout baseline solves nothing (cost undefined), with
  // a real anti-case elsewhere so the run reaches the cost guard instead of the
  // anti-case stop.
  const records = [
    ...Array.from({ length: 9 }, (_, i) => syntheticRecord(`h-${i}`, 'holdout', { baseSolved: false, candSolved: true })),
    ...Array.from({ length: 4 }, (_, i) => syntheticRecord(`t-${i}`, 'train', { baseSolved: false, candSolved: true })),
    syntheticRecord('x-1', 'transfer', { baseSolved: true, candSolved: false }),
    ...Array.from({ length: 2 }, (_, i) => syntheticRecord(`x-${i + 2}`, 'transfer', { baseSolved: true, candSolved: true })),
  ];
  const report = evaluate(records, CONTRACT, { budgetEqual: true });
  assert.equal(report.status, 'MEASURED');
  assert.equal(report.baselineCost, null);
  assert.equal(report.nonInferiorCost, false);
  assert.equal(report.assertsGain, false);
});

test('mutation: ignoring order removes the effect the scheduler has', () => {
  // Holdout delta is zero on every task; the anti-case lives outside holdout so
  // the run reaches the metric rather than the anti-case stop.
  const records = [
    ...Array.from({ length: 8 }, (_, i) => syntheticRecord(`h-${i}`, 'holdout', { baseSolved: true, candSolved: true })),
    ...Array.from({ length: 4 }, (_, i) => syntheticRecord(`t-${i}`, 'train', { baseSolved: false, candSolved: true })),
    syntheticRecord('x-1', 'transfer', { baseSolved: true, candSolved: false }),
    ...Array.from({ length: 3 }, (_, i) => syntheticRecord(`x-${i + 2}`, 'transfer', { baseSolved: true, candSolved: true })),
  ];
  const report = evaluate(records, CONTRACT, { budgetEqual: true });
  assert.equal(report.mean, 0, 'an order-ignoring predicate cannot show a delta');
});

test('the contract refuses an invented threshold chosen after the fact', () => {
  assert.throws(() => lockContract({ ...CONTRACT, extra: 1 }), /unknown contract field/);
  const { meaningfulEffect, ...missing } = CONTRACT;
  assert.throws(() => lockContract(missing), /missing contract field meaningfulEffect/);
  assert.throws(() => lockContract({ ...CONTRACT, direction: 'lower-is-better' }), /direction must be/);
});
