'use strict';

// R50 PR2 (issue #3582): the evaluator scores an arm against the frozen human
// labels. These tests lock the properties that make the report a measurement:
//
//   - arm A's declared heuristic confidence is labelled DECLARED_HEURISTIC and
//     never scored as a calibrated probability (no Brier/ECE for it);
//   - arm B's calibrated probability carries real Brier/ECE;
//   - both arms score exactly the same decisions, so PR4 can pair them;
//   - UNCERTAIN and INVALID_PAIR are exclusions, not binary failures;
//   - the contradiction path calls only the contradiction rules, never the risk
//     rules, so risk signals cannot leak into the benchmark;
//   - a label the corpus does not carry is a hard failure, not a dropped pair.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const evaluator = require('../lib/cognitive-lab-contradiction-evaluator.js');

const {
  EVALUATOR_STATUS, PROBABILITY_KIND, RULE_ORDER, EVALUATOR_ERROR_CODES,
  ContradictionEvaluatorError, contradictionRuleScore, armADeclared, armBCalibrated,
  evaluateContradictionArm, joinCorpusLabels, runContradictionBaseline,
} = evaluator;

const CORPUS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/contradiction-eval-v1.corpus.json'), 'utf8'));
const LABELS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/contradiction-eval-v1.labels.json'), 'utf8'));
const CONTRACT = Object.freeze({ minimumSamples: 10, smoothingAlpha: 0.5 });

function throwsCode(fn, code) {
  assert.throws(fn, (error) => error instanceof ContradictionEvaluatorError && error.code === code, `expected ${code}`);
}

// --- the frozen corpus drives the arms --------------------------------------

test('the A/B measurement runs on the frozen holdout and is deterministic', () => {
  const first = runContradictionBaseline({ corpus: CORPUS, labels: LABELS, contract: CONTRACT, threshold: 0.5 });
  const second = runContradictionBaseline({ corpus: CORPUS, labels: LABELS, contract: CONTRACT, threshold: 0.5 });
  assert.equal(first.status, EVALUATOR_STATUS.MEASURED);
  assert.equal(first.arms.A.probabilityKind, PROBABILITY_KIND.DECLARED_HEURISTIC);
  assert.equal(first.arms.B.probabilityKind, PROBABILITY_KIND.CALIBRATED);
  assert.deepEqual(first.arms.A.confusion, second.arms.A.confusion);
  assert.equal(first.calibrator.artifact.digest, second.calibrator.artifact.digest);
});

test('arm A never reports Brier/ECE; arm B does', () => {
  const result = runContradictionBaseline({ corpus: CORPUS, labels: LABELS, contract: CONTRACT, threshold: 0.5 });
  assert.equal(result.arms.A.calibration, null);
  assert.equal(result.arms.B.calibration.status, 'MEASURED');
  assert.ok(Number.isFinite(result.arms.B.calibration.brier));
  assert.ok(Number.isFinite(result.arms.B.calibration.ece));
});

test('both arms score exactly the same decisions so they can be paired', () => {
  const result = runContradictionBaseline({ corpus: CORPUS, labels: LABELS, contract: CONTRACT, threshold: 0.5 });
  const idsA = result.arms.A.decisions.map((decision) => decision.pairId).sort();
  const idsB = result.arms.B.decisions.map((decision) => decision.pairId).sort();
  assert.deepEqual(idsA, idsB);
  assert.ok(idsA.length > 0);
});

// --- exclusions -------------------------------------------------------------

test('UNCERTAIN and INVALID_PAIR are exclusions, not binary failures', () => {
  const records = [
    { pairId: 'p1', split: 'holdout', stored: { text: 'a is 1', subject: 's' }, incoming: { text: 'a is 2', subject: 's' }, label: 'CONTRADICTION' },
    { pairId: 'p2', split: 'holdout', stored: { text: 'x' }, incoming: { text: 'y' }, label: 'UNCERTAIN' },
    { pairId: 'p3', split: 'holdout', stored: { text: 'x' }, incoming: { text: 'y' }, label: 'INVALID_PAIR' },
  ];
  const arm = evaluateContradictionArm({ records, predict: armADeclared, threshold: 0.5 });
  assert.equal(arm.measurement.support, 1);
  assert.equal(arm.measurement.exclusions.UNCERTAIN, 1);
  assert.equal(arm.measurement.exclusions.INVALID_PAIR, 1);
});

test('a corpus pair with no label is a hard failure, not a dropped pair', () => {
  const corpus = { records: [{ pairId: 'pair:missing', split: 'train', stored: {}, incoming: {} }] };
  const labels = { labels: {} };
  throwsCode(() => joinCorpusLabels(corpus, labels), EVALUATOR_ERROR_CODES.INVALID_RECORD);
});

// --- rule isolation ---------------------------------------------------------

test('the contradiction score uses only the contradiction rules', () => {
  // A risk-only pair (no contradiction rule fires) scores 0: the risk rules are
  // not consulted, so a risk signal cannot inflate the contradiction arm.
  const record = {
    pairId: 'pair:risk-only', split: 'holdout',
    stored: { text: 'the server is online', subject: 'svc:server', relation: 'is' },
    incoming: { text: 'the server is online', subject: 'svc:server', relation: 'is' },
  };
  const score = contradictionRuleScore(record);
  assert.equal(score.score, 0);
  assert.equal(score.signalCount, 0);
});

test('the frozen rule order matches the repo detectors', () => {
  assert.deepEqual([...RULE_ORDER], [
    'NUMERICAL_CONFLICT', 'VALUE_CONFLICT', 'TYPE_CONFLICT', 'NEGATION_CONFLICT', 'UNIT_CONFLICT',
    'CAUSE_PREVENT_OPPOSITION', 'SEMANTIC_OPPOSITION', 'RELATION_INVERSION', 'PREDICATE_DRIFT',
  ]);
});

// --- metrics ----------------------------------------------------------------

test('confusion and discrimination metrics are reported for a scored arm', () => {
  const records = [
    { pairId: 'p1', split: 'holdout', stored: { text: 'temp is 10 celsius', subject: 's' }, incoming: { text: 'temp is 20 celsius', subject: 's' }, label: 'CONTRADICTION' },
    { pairId: 'p2', split: 'holdout', stored: { text: 'the sky is blue', subject: 's2' }, incoming: { text: 'the sky is blue', subject: 's2' }, label: 'NOT_CONTRADICTION' },
  ];
  const arm = evaluateContradictionArm({ records, predict: armADeclared, threshold: 0.5 });
  assert.equal(arm.confusion.tp, 1);
  assert.equal(arm.confusion.tn, 1);
  assert.equal(arm.metrics.precision, 1);
  assert.equal(arm.metrics.recall, 1);
  assert.equal(arm.metrics.falsePositiveRate, 0);
  assert.equal(arm.metrics.coverage, 0.5);
});

test('a non-finite predicted probability is rejected', () => {
  const records = [{ pairId: 'p1', split: 'holdout', stored: {}, incoming: {}, label: 'CONTRADICTION' }];
  throwsCode(() => evaluateContradictionArm({ records, predict: () => ({ score: 0, probability: Number.NaN }), threshold: 0.5 }),
    EVALUATOR_ERROR_CODES.NON_FINITE_PREDICTION);
});

test('an out-of-range threshold is rejected', () => {
  throwsCode(() => evaluateContradictionArm({ records: [], predict: armADeclared, threshold: 2 }),
    EVALUATOR_ERROR_CODES.INVALID_THRESHOLD);
});

// --- calibration insufficiency ----------------------------------------------

test('an insufficient calibration split yields INSUFFICIENT with no arms', () => {
  const corpus = { records: [{ pairId: 'pair:1', split: 'calibration', stored: { text: 'a is 1', subject: 's' }, incoming: { text: 'a is 2', subject: 's' } }] };
  const labels = { labels: { 'pair:1': { label: 'CONTRADICTION' } } };
  const result = runContradictionBaseline({ corpus, labels, contract: CONTRACT });
  assert.equal(result.status, EVALUATOR_STATUS.INSUFFICIENT);
  assert.equal(result.arms, null);
  assert.equal(result.reason, 'calibration_insufficient');
});

test('a pinned source commit adds the C arm; without it the A/B report is unchanged', () => {
  const withoutC = runContradictionBaseline({ corpus: CORPUS, labels: LABELS, contract: CONTRACT, threshold: 0.5 });
  const withC = runContradictionBaseline({ corpus: CORPUS, labels: LABELS, contract: CONTRACT, threshold: 0.5, sourceCommit: 'a'.repeat(40) });
  assert.deepEqual(Object.keys(withoutC.arms), ['A', 'B']);
  assert.deepEqual(Object.keys(withC.arms), ['A', 'B', 'C']);
  assert.equal(withoutC.fusion, null);
  assert.equal(withC.fusion.status, 'MEASURED');
  assert.equal(withC.arms.C.probabilityKind, PROBABILITY_KIND.CALIBRATED);
  // A and B are identical whether or not C is present.
  assert.deepEqual(withC.arms.A.confusion, withoutC.arms.A.confusion);
  assert.deepEqual(withC.arms.B.confusion, withoutC.arms.B.confusion);
});

test('armBCalibrated maps the same raw score through the frozen artifact', () => {
  const records = Array.from({ length: 10 }, (_, index) => ({
    pairId: `pair:${index}`, split: 'calibration',
    stored: { text: 'temp is 10 celsius', subject: 's' }, incoming: { text: 'temp is 20 celsius', subject: 's' },
    label: index % 2 === 0 ? 'CONTRADICTION' : 'NOT_CONTRADICTION',
  }));
  const fit = require('../lib/cognitive-lab-contradiction-calibrator.js').fitCalibration({
    records: records.map((record) => ({ decisionId: record.pairId, split: 'calibration', score: contradictionRuleScore(record).score, label: record.label })),
    contract: CONTRACT,
  });
  const prediction = armBCalibrated(records[0], fit.artifact);
  assert.equal(prediction.probabilityKind, PROBABILITY_KIND.CALIBRATED);
  assert.ok(prediction.probability >= 0 && prediction.probability <= 1);
});
