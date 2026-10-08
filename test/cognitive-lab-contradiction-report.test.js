'use strict';

// R50 PR4 (issue #3582): the preregistered A/B/C report. These tests lock the
// comparison discipline:
//
//   - the primary comparison is C vs B, not C vs A;
//   - the four final states map from the paired delta, and a C that loses is a
//     valid, publishable outcome (fusion rejected by measurement);
//   - Brier/ECE appear only for a real frozen probability (B, C), never for A;
//   - the weakness profile is support-gated: below the floor it refuses to
//     claim rather than printing a ratio;
//   - the report never wires production, never promotes.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  FINAL_STATE, REPORT_ERROR_CODES, DEFAULT_REPORT_CONTRACT, MIN_DETECTOR_SUPPORT,
  ContradictionReportError, weaknessProfile, runContradictionReport,
} = require('../lib/cognitive-lab-contradiction-report.js');
const { PAIRED_STATUS } = require('../lib/cognitive-lab-paired-delta.js');
const { joinCorpusLabels, RULE_ORDER } = require('../lib/cognitive-lab-contradiction-evaluator.js');

const CORPUS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/contradiction-eval-v1.corpus.json'), 'utf8'));
const LABELS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/contradiction-eval-v1.labels.json'), 'utf8'));
const CONTRACT = Object.freeze({ minimumSamples: 10, smoothingAlpha: 0.5 });
const COMMIT = 'a'.repeat(40);

function report(overrides = {}) {
  return runContradictionReport({
    records: joinCorpusLabels(CORPUS, LABELS), contract: CONTRACT, threshold: 0.5, sourceCommit: COMMIT, ...overrides,
  });
}

test('the frozen report measures all three arms on the same holdout', () => {
  const result = report();
  assert.equal(result.status, 'MEASURED');
  assert.deepEqual(Object.keys(result.arms), ['A', 'B', 'C']);
  assert.equal(result.arms.A.probabilityKind, 'DECLARED_HEURISTIC');
  assert.equal(result.arms.B.probabilityKind, 'CALIBRATED');
  assert.equal(result.arms.C.probabilityKind, 'CALIBRATED');
  // The same scorable holdout decisions underpin every arm.
  const ids = result.arms.C.decisions.map((decision) => decision.pairId);
  assert.deepEqual(result.arms.B.decisions.map((decision) => decision.pairId), ids);
  assert.deepEqual(result.arms.A.decisions.map((decision) => decision.pairId), ids);
});

test('the primary comparison is C vs B, not C vs A', () => {
  const result = report();
  assert.equal(result.comparison.primary.baseline, 'B');
  assert.equal(result.comparison.primary.candidate, 'C');
  assert.equal(result.comparison.primary.delta.status, PAIRED_STATUS.MEASURED);
  assert.match(result.comparison.note, /primary comparison is C vs B/);
});

test('Brier/ECE appear only for a real frozen probability', () => {
  const result = report();
  assert.equal(result.arms.A.calibration, null, 'arm A declared confidence is not a calibrated probability');
  assert.ok(result.arms.B.calibration && Number.isFinite(result.arms.B.calibration.brier));
  assert.ok(result.arms.C.calibration && Number.isFinite(result.arms.C.calibration.brier));
});

test('the final state maps from the paired delta and a losing C is a valid outcome', () => {
  const result = report();
  assert.ok(Object.values(FINAL_STATE).includes(result.finalState));
  // The frozen holdout does not clear the locked meaningful effect: C is not
  // measurably better than B, which is a legitimate, publishable result.
  assert.equal(result.finalState, FINAL_STATE.NO_MEANINGFUL_IMPROVEMENT);
  assert.equal(result.fusionRejected, true);
  assert.equal(result.assertsGain, false);
  assert.ok(result.comparison.primary.delta.delta.brier.mean >= 0);
});

test('the report is deterministic for the same inputs', () => {
  assert.equal(report().evidenceDigest, report().evidenceDigest);
});

test('the weakness profile is support-gated and covers the frozen rule order', () => {
  const profile = weaknessProfile(joinCorpusLabels(CORPUS, LABELS).filter((record) => record.split === 'holdout'));
  assert.deepEqual(profile.map((entry) => entry.rule), [...RULE_ORDER]);
  for (const entry of profile) {
    if (entry.support < MIN_DETECTOR_SUPPORT) {
      assert.equal(entry.claim, 'INSUFFICIENT_FOR_DETECTOR_CLAIM');
      assert.equal(entry.precision, null);
    } else {
      assert.equal(entry.claim, 'MEASURED');
      assert.ok(Number.isFinite(entry.precision));
    }
  }
});

test('an insufficient calibration split is INSUFFICIENT, not a report', () => {
  const records = joinCorpusLabels(CORPUS, LABELS).filter((record) => record.split !== 'calibration')
    .concat(joinCorpusLabels(CORPUS, LABELS).filter((record) => record.split === 'calibration').slice(0, 2));
  const result = runContradictionReport({ records, contract: CONTRACT, threshold: 0.5, sourceCommit: COMMIT });
  assert.equal(result.status, 'INSUFFICIENT');
  assert.equal(result.finalState, FINAL_STATE.INSUFFICIENT);
  assert.equal(result.arms, null);
});

test('the report never wires production or promotes', () => {
  const result = report();
  assert.equal(result.productionBehaviorChanged, false);
  assert.equal(result.automaticPromotion, false);
  assert.deepEqual(DEFAULT_REPORT_CONTRACT.direction, 'lower-brier-is-better');
});

test('an empty record set is refused', () => {
  assert.throws(() => runContradictionReport({ records: [], contract: CONTRACT, sourceCommit: COMMIT }),
    (error) => error instanceof ContradictionReportError && error.code === REPORT_ERROR_CODES.INVALID_INPUT);
});
