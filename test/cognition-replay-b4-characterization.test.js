'use strict';

/**
 * COG-M3 replay selection measurement (#4069 PR-5), run against the frozen
 * preregistration `docs/task-packs/cog-m3-replay-preregistration-20261027.md`.
 *
 * This is a *selection-level characterization*, not the §9 H1 experiment. The
 * H1 arm (candidates applied to held-out transfer tasks through the real Coder
 * runtime) needs the family-level paired adapter the preregistration §6 leaves
 * open; it is reported `NOT_RUN`, not faked here. What this file does measure,
 * on a frozen episode corpus, through the real modules:
 *
 *   - `lib/cognition/replay-generalize.js::groupForCandidates` (arm A2,
 *     priority top-K) versus `::groupForRecentCandidates` (arm A1, recent-K);
 *   - `lib/cognitive-lab-b4-evaluator.js::evaluate` under the frozen B4
 *     contract (seed 3310, 2000 resamples, 0.95, minimumSamples 24,
 *     minimumTransfer 8, wrongWriteTolerance 0).
 *
 * `assertsGain` is `false` in every branch: the fixture is a constant, not a
 * task sample, so no statistical claim is made. The corpus is a fixed literal
 * with fixed timestamps, so the report is byte-identical across runs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { groupForCandidates, groupForRecentCandidates } = require('../lib/cognition/replay-generalize');
const { evaluate, CONTRACT } = require('../lib/cognitive-lab-b4-evaluator');
const { computeManifestDigest } = require('../lib/cognitive-lab-manifest');

const WORKSPACE = 'default';
const REPLAYED_AT = '2026-10-30T00:00:00.000Z';
const BUDGET = 3;

// Each task is one `(workspaceId, key, frameTask)` group. The categories differ
// only in which episodes are newest and how large their measured signals are,
// so the two selection orders (priority vs recent-K) can disagree. Priority
// sorts by magnitude, recent-K by time, so the two are complementary:
//   P_win  three independent positives are the highest magnitude but the OLDEST
//          episodes; the newest episodes are low-magnitude correlated copies, so
//          priority recovers the procedure and recent-K does not.
//   R_win  the independent positives are the NEWEST but low magnitude; the
//          high-magnitude older episodes are correlated copies, so recent-K
//          recovers the procedure and priority does not.
//   BOTH   the independent positives are both newest and highest magnitude.
//   NONE   only two independent sources: neither order can reach MIN_GROUP_SIZE.
//   NEG    three independent negative sources: an avoidance pattern, not a
//          procedure.
//   FAIL   mixed signs: consistency stays below CONSISTENCY_MIN.
// The label is what the replay gate *should* emit; the gate is the arbiter, so
// a strategy that picks the wrong support set emits no candidate at all.
const CLASSES = Object.freeze({
  P_win: { label: 'procedure', positives: 3, duplicates: 2, positiveMagnitude: 0.9, duplicateMagnitude: 0.2, duplicatesNewest: true },
  R_win: { label: 'procedure', positives: 3, duplicates: 2, positiveMagnitude: 0.2, duplicateMagnitude: 0.9, duplicatesNewest: false },
  BOTH: { label: 'procedure', positives: 3, duplicates: 2, positiveMagnitude: 0.9, duplicateMagnitude: 0.2, duplicatesNewest: false },
  NONE: { label: 'none', positives: 2, duplicates: 2, positiveMagnitude: 0.9, duplicateMagnitude: 0.2, duplicatesNewest: true },
  NEG: { label: 'avoidance', positives: 3, duplicates: 0, positiveMagnitude: 0.9, duplicateMagnitude: 0.2, duplicatesNewest: true, negative: true },
  FAIL: { label: 'none', positives: 3, duplicates: 0, positiveMagnitude: 0.9, duplicateMagnitude: 0.2, duplicatesNewest: true, oneNegative: true },
});

function buildTask(id, category, split) {
  const spec = CLASSES[category];
  const key = `cap:${category}-${id}`;
  const base = Date.UTC(2026, 9, 20) + id * 1e7;
  // Timestamps are assigned by role, not creation order: `duplicatesNewest`
  // decides whether the correlated copies or the independent sources are the
  // most recent episodes, which is exactly the signal recent-K reads.
  const episode = (suffix, sourceGroup, magnitude, reward, tick) => ({
    episodeId: `${category}-${id}-${suffix}`, workspaceId: WORKSPACE, key, frameTask: 'replace_text',
    at: new Date(base + tick * 1000).toISOString(), predictionError: { status: 'MEASURED', magnitude },
    reward: { status: 'MEASURED', reward, rpe: reward },
    sourceGroup, sourceRefs: [`src:${sourceGroup}`],
  });
  const sign = spec.negative ? -1 : 1;
  const older = 0;
  const newer = spec.positives;
  const independentTick = spec.duplicatesNewest ? older : newer;
  const duplicateTick = spec.duplicatesNewest ? newer : older;
  const independent = Array.from({ length: spec.positives }, (_, index) => episode(`p${index}`, `g-${id}-${index}`,
    spec.positiveMagnitude, index === spec.positives - 1 && spec.oneNegative ? -1 : sign, independentTick + index));
  const duplicates = Array.from({ length: spec.duplicates }, (_, index) => episode(`d${index}`, `g-${id}-0`,
    spec.duplicateMagnitude, sign, duplicateTick + index));
  const episodes = [...independent, ...duplicates];
  return { taskId: key, split, class: spec.label === 'procedure' ? 'i' : 'iii', key, category,
    expected: spec.label === 'none' ? 'refuse' : 'change', label: spec.label, episodes };
}

// Holdout 24 and transfer 8 are the B4 contract floors. The composition is a
// design choice, not a sample: it exercises both orders in both directions.
const PLAN = Object.freeze([
  ['holdout', 'P_win', 5], ['holdout', 'R_win', 5], ['holdout', 'BOTH', 6],
  ['holdout', 'NONE', 3], ['holdout', 'NEG', 3], ['holdout', 'FAIL', 2],
  ['transfer', 'P_win', 2], ['transfer', 'R_win', 2], ['transfer', 'BOTH', 2], ['transfer', 'NONE', 2],
]);

function buildCorpus() {
  const tasks = [];
  let id = 0;
  for (const [split, category, count] of PLAN) {
    for (let index = 0; index < count; index += 1) tasks.push(buildTask(id++, category, split));
  }
  return Object.freeze(tasks);
}

const TASKS = buildCorpus();
const CORPUS_DIGEST = computeManifestDigest({ tasks: TASKS.map(task => ({ taskId: task.taskId, split: task.split,
  class: task.class, category: task.category })), budget: BUDGET, workspaceId: WORKSPACE, replayedAt: REPLAYED_AT });
const OPTIONS = Object.freeze({ workspaceId: WORKSPACE, replayedAt: REPLAYED_AT, budget: BUDGET });

// The candidate kind an arm emits for a task; `none` means the gate refused to
// produce a candidate (the correct answer for NONE and FAIL).
const kindOf = (result) => (result.candidates.length ? result.candidates[0].candidateKind : 'none');

function observe(task) {
  const recent = groupForRecentCandidates(task.episodes, OPTIONS);
  const priority = groupForCandidates(task.episodes, OPTIONS);
  return { recent, priority, recentKind: kindOf(recent), priorityKind: kindOf(priority) };
}

// One B4 record per task. `correct` is the arm's selection decision against the
// frozen label; the arms never write, so `changed` is empty and a candidate the
// gate should have refused would surface as a wrong write, not a silent success.
function recordsOf() {
  return TASKS.map(task => {
    const { recentKind, priorityKind } = observe(task);
    const arm = (kind) => ({ correct: kind === task.label ? 1 : 0, wrongWrite: 0, changed: [], dispatches: 1 });
    return { taskId: task.taskId, split: task.split, class: task.class, expected: task.expected,
      label: task.label, A0: arm('none'), A1: arm(recentKind), A2: arm(priorityKind),
      O: { correct: 1, wrongWrite: 0, changed: [], dispatches: 1 } };
  });
}

test('the frozen replay corpus separates priority from recent-K under the B4 contract', t => {
  const records = recordsOf();
  const report = evaluate(records, CONTRACT, { tasks: [], trainContents: [] });
  t.diagnostic(JSON.stringify({ corpusDigest: CORPUS_DIGEST, tasks: TASKS.length, report }));

  // The measurement is valid and reports no gain: the fixture is a constant.
  assert.equal(report.status, 'MEASURED', JSON.stringify(report));
  assert.equal(report.reason, 'interval_below_meaningful_effect');
  assert.equal(report.assertsGain, false);
  assert.equal(report.clearsEffect, false);
  // Both orders are exercised: the arms disagree task-by-task (the evaluator's
  // own `gates_inert` guard), even though the balanced design ties their totals.
  assert.ok(records.some(record => record.A1.correct !== record.A2.correct));
  // Nothing was written and no candidate was smuggled past the gate.
  assert.deepEqual(report.wrongWrites, { A0: 0, A1: 0, A2: 0 });
  assert.equal(report.holdoutSize, 24);
  assert.equal(report.transferCorrect.A2, report.transferCorrect.A1);
  // The balanced fixture has no aggregate advantage, so the paired interval
  // includes the meaningful effect and no gain is asserted.
  assert.equal(report.primary.mean, 0);
  assert.ok(report.primary.interval.lower <= CONTRACT.meaningfulEffect);
  assert.equal(report.intelligenceGain, 'NOT_MEASURED');
});

test('the report is byte-identical across runs and the corpus is not mutated', () => {
  const before = JSON.stringify(TASKS.map(task => task.episodes));
  const first = evaluate(recordsOf(), CONTRACT, { tasks: [], trainContents: [] });
  const second = evaluate(recordsOf(), CONTRACT, { tasks: [], trainContents: [] });
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(TASKS.map(task => task.episodes)), before);
  assert.equal(CORPUS_DIGEST, computeManifestDigest({ tasks: TASKS.map(task => ({ taskId: task.taskId, split: task.split,
    class: task.class, category: task.category })), budget: BUDGET, workspaceId: WORKSPACE, replayedAt: REPLAYED_AT }));
});

test('the gate refuses correlated-only support, so no arm can manufacture a candidate', () => {
  // A group whose three "positives" are all copies of one source: recent-K sees
  // them as newest, priority sees them as high magnitude, and both must refuse.
  const key = 'cap:correlated-only';
  const episodes = Array.from({ length: 3 }, (_, index) => ({
    episodeId: `corr-${index}`, workspaceId: WORKSPACE, key, frameTask: 'replace_text',
    at: new Date(Date.UTC(2026, 9, 25, 0, index)).toISOString(),
    predictionError: { status: 'MEASURED', magnitude: 0.9 }, reward: { status: 'MEASURED', reward: 1, rpe: 1 },
    sourceGroup: 'g-shared', sourceRefs: ['src:shared'],
  }));
  for (const result of [groupForCandidates(episodes, OPTIONS), groupForRecentCandidates(episodes, OPTIONS)]) {
    assert.equal(result.candidates.length, 0, JSON.stringify(result.candidates));
    assert.equal(result.registered, false);
    assert.equal(result.authority, 'CANDIDATE_ONLY');
  }
});

test('every emitted candidate stays candidate-only with no promotion surface', () => {
  for (const task of TASKS) {
    const { recent, priority } = observe(task);
    for (const candidate of [...recent.candidates, ...priority.candidates]) {
      assert.equal(candidate.registered, false);
      assert.equal(candidate.authority, 'CANDIDATE_ONLY');
      assert.equal(candidate.promotionInput, null);
      assert.ok(candidate.support.length >= 3);
      assert.ok(candidate.consistency >= 0.8);
    }
  }
});

test('abstained signals are skipped, never scored as zero', () => {
  const key = 'cap:abstain';
  const episodes = Array.from({ length: 3 }, (_, index) => ({
    episodeId: `ab-${index}`, workspaceId: WORKSPACE, key, frameTask: 'replace_text',
    at: new Date(Date.UTC(2026, 9, 25, 0, index)).toISOString(),
    predictionError: { status: 'ABSTAIN', magnitude: null }, reward: { status: 'MEASURED', reward: 1, rpe: 1 },
    sourceGroup: `g-${index}`, sourceRefs: [`src:${index}`],
  }));
  const result = groupForCandidates(episodes, OPTIONS);
  assert.equal(result.candidates.length, 0);
  assert.deepEqual(result.skipped.map(row => row.episodeId), ['ab-0', 'ab-1', 'ab-2']);
});
