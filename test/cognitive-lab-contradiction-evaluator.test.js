'use strict';

/**
 * Contradiction rule-baseline evaluator (#3582, R50 PR2).
 *
 * - Arms A and B share the detector's decision, so they must agree on every
 *   confusion cell; only the probability they carry differs.
 * - Only the contradiction rule set is measured: risk signals never reach the
 *   contradiction benchmark.
 * - The mapping is fitted from the calibration split alone; changing a holdout
 *   label must not move it.
 * - `UNCERTAIN`/`INVALID_PAIR` are exclusion counts, never binary failures.
 * - Brier/ECE is reported for arm B's calibrated probability only; arm A's
 *   declared heuristic confidence is never scored.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const {
  EVAL_STATUS, evaluateRuleBaseline, confusionOf, signalsFor,
} = require('../lib/cognitive-lab-contradiction-evaluator');
const { PROBABILITY_KIND, verifyMappingDigest, fitScoreMapping } = require('../lib/cognitive-lab-contradiction-calibrator');
const corpus = require('./fixtures/contradiction-eval-v1.corpus.json');
const labels = require('./fixtures/contradiction-eval-v1.labels.json').labels;

function cloneLabels() {
  return JSON.parse(JSON.stringify(labels));
}

test('arms A and B share the detector decision on every scorable pair', () => {
  const report = evaluateRuleBaseline({ corpus, labels });
  assert.equal(report.status, EVAL_STATUS.MEASURED);
  assert.deepEqual(report.arms.A.confusion, report.arms.B.confusion);
  assert.deepEqual(report.arms.A.confusion, report.detector.confusion);
  for (const row of report.rows) {
    assert.equal(row.armA.predicted, row.detected);
    assert.equal(row.armB.predicted, row.detected);
  }
});

test('the detector confusion matches an independent hand-count', () => {
  const report = evaluateRuleBaseline({ corpus, labels });
  const detected = report.rows.filter((row) => row.detected === 1);
  const tp = detected.filter((row) => row.y === 1).length;
  const fp = detected.filter((row) => row.y === 0).length;
  const fn = report.rows.filter((row) => row.detected === 0 && row.y === 1).length;
  const tn = report.rows.filter((row) => row.detected === 0 && row.y === 0).length;
  assert.equal(report.detector.confusion.tp, tp);
  assert.equal(report.detector.confusion.fp, fp);
  assert.equal(report.detector.confusion.fn, fn);
  assert.equal(report.detector.confusion.tn, tn);
  assert.equal(report.detector.confusion.support, tp + fp + tn + fn);
});

test('arm A is DECLARED_HEURISTIC and is never scored as a forecast', () => {
  const report = evaluateRuleBaseline({ corpus, labels });
  assert.equal(report.arms.A.probabilityKind, PROBABILITY_KIND.DECLARED_HEURISTIC);
  assert.equal(report.arms.A.probability.status, 'NOT_A_FORECAST');
  assert.equal(report.arms.A.probability.brier, null);
  assert.equal(report.arms.A.probability.ece, null);
});

test('arm B is CALIBRATED and its forecast is scored with Brier/ECE', () => {
  const report = evaluateRuleBaseline({ corpus, labels });
  assert.equal(report.arms.B.probabilityKind, PROBABILITY_KIND.CALIBRATED);
  assert.equal(report.arms.B.probability.status, 'MEASURED');
  assert.equal(typeof report.arms.B.probability.brier, 'number');
  assert.equal(typeof report.arms.B.probability.ece, 'number');
  assert.ok(report.arms.B.probability.brier >= 0 && report.arms.B.probability.brier <= 1);
});

test('the mapping is fitted from the calibration split only', () => {
  const report = evaluateRuleBaseline({ corpus, labels });
  assert.ok(report.calibration.pairIds.length > 0);
  const splitOf = new Map(corpus.records.map((record) => [record.pairId, record.split]));
  for (const pairId of report.calibration.pairIds) {
    assert.equal(splitOf.get(pairId), 'calibration', `${pairId} must be a calibration pair`);
  }
  assert.equal(report.calibration.sampleCount, report.calibration.pairIds.length);
  assert.match(report.calibration.mappingDigest, /^[a-f0-9]{64}$/);
  assert.equal(report.calibration.mappingStatus, 'FITTED');
});

test('changing a holdout label does not move the calibration mapping', () => {
  const base = evaluateRuleBaseline({ corpus, labels });
  const mutated = cloneLabels();
  const holdoutPair = corpus.records.find((record) => record.split === 'holdout');
  mutated[holdoutPair.pairId].label = mutated[holdoutPair.pairId].label === 'CONTRADICTION'
    ? 'NOT_CONTRADICTION' : 'CONTRADICTION';
  const after = evaluateRuleBaseline({ corpus, labels: mutated });
  assert.equal(after.calibration.mappingDigest, base.calibration.mappingDigest);
  // The holdout score can move; the mapping cannot.
  assert.notDeepEqual(after.detector.bySplit.holdout, base.detector.bySplit.holdout);
});

test('UNCERTAIN and INVALID_PAIR are exclusions, not binary failures', () => {
  const report = evaluateRuleBaseline({ corpus, labels });
  const scorable = corpus.records.filter((record) => {
    const label = labels[record.pairId].label;
    return label === 'CONTRADICTION' || label === 'NOT_CONTRADICTION';
  });
  assert.equal(report.detector.confusion.support, scorable.length);
  assert.equal(report.exclusions.UNCERTAIN, 10);
  assert.equal(report.exclusions.INVALID_PAIR, 6);
  assert.equal(report.exclusions.UNCERTAIN + report.exclusions.INVALID_PAIR + scorable.length,
    corpus.records.length);
});

test('an unknown label is excluded, not scored as a negative', () => {
  const mutated = cloneLabels();
  const target = corpus.records[0].pairId;
  mutated[target] = { label: 'MAYBE' };
  const report = evaluateRuleBaseline({ corpus, labels: mutated });
  assert.equal(report.exclusions.unknownLabel, 1);
  assert.ok(!report.rows.some((row) => row.pairId === target));
});

test('a missing label is excluded, not scored', () => {
  const mutated = cloneLabels();
  const target = corpus.records[0].pairId;
  delete mutated[target];
  const report = evaluateRuleBaseline({ corpus, labels: mutated });
  assert.equal(report.exclusions.missingLabel, 1);
  assert.ok(!report.rows.some((row) => row.pairId === target));
});

test('a supplied mapping must verify its digest', () => {
  assert.throws(() => evaluateRuleBaseline({ corpus, labels, mapping: { edges: [1], probabilities: [0.5], digest: 'x' } }),
    /digest does not verify/);
});

test('a pre-fitted mapping is used verbatim and its digest is reported', () => {
  const samples = [];
  const { runContradictionRules } = require('../lib/contradiction-rules');
  for (const record of corpus.records.filter((entry) => entry.split === 'calibration')) {
    const label = labels[record.pairId] && labels[record.pairId].label;
    if (label !== 'CONTRADICTION' && label !== 'NOT_CONTRADICTION') continue;
    const severity = runContradictionRules(record.stored, record.incoming)
      .reduce((max, signal) => Math.max(max, signal.severity || 0), 0);
    samples.push({ score: severity, label: label === 'CONTRADICTION' ? 1 : 0 });
  }
  const fitted = fitScoreMapping({ samples });
  const report = evaluateRuleBaseline({ corpus, labels, mapping: fitted.mapping });
  assert.equal(report.calibration.mappingDigest, fitted.digest);
  assert.equal(report.calibration.mappingStatus, 'FITTED');
  assert.deepEqual(report.arms.B.confusion, report.arms.A.confusion);
});

test('a corpus with no scorable pair is INSUFFICIENT', () => {
  const report = evaluateRuleBaseline({
    corpus: { records: [{ pairId: 'pair:only', split: 'train', stored: { text: 'a' }, incoming: { text: 'b' } }] },
    labels: { 'pair:only': { label: 'UNCERTAIN' } },
  });
  assert.equal(report.status, EVAL_STATUS.INSUFFICIENT);
  assert.equal(report.reason, 'no_scorable_pairs');
});

test('the evaluator runs the contradiction rule set only', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cognitive-lab-contradiction-evaluator.js'), 'utf8');
  assert.ok(source.includes("require('./contradiction-rules')"));
  assert.ok(!source.includes('risk-rules'));
  assert.ok(!source.includes('semantic-signals'));
});

test('the report is deterministic and candidate-only', () => {
  const first = evaluateRuleBaseline({ corpus, labels });
  const second = evaluateRuleBaseline({ corpus, labels });
  assert.equal(first.calibration.mappingDigest, second.calibration.mappingDigest);
  assert.deepEqual(first.detector.confusion, second.detector.confusion);
  assert.equal(first.assertsGain, false);
  assert.deepEqual(first.authority, {
    kind: 'DETERMINISTIC', locality: 'LOCAL', authority: 'CANDIDATE_ONLY',
    canonical: false, modelCalls: 0, tokens: 0, externalCalls: 0,
  });
});

test('a detector that throws on a malformed record yields no signal, not a crash', () => {
  const record = { stored: { get text() { throw new Error('boom'); } }, incoming: { text: 'x' } };
  const signal = signalsFor(record);
  assert.equal(signal.count, 0);
  assert.equal(signal.maxSeverity, 0);
  assert.deepEqual(signal.ruleIds, []);
});

test('a supplied mapping whose shape cannot be canonicalised fails verification', () => {
  assert.equal(verifyMappingDigest({ digest: 'x', get edges() { throw new Error('boom'); } }), false);
});

test('confusionOf reports null ratios when there is no support', () => {
  const empty = confusionOf([]);
  assert.equal(empty.precision, null);
  assert.equal(empty.recall, null);
  assert.equal(empty.falsePositiveRate, null);
  assert.equal(empty.coverage, null);
});
