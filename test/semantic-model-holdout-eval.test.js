'use strict';

// R51 PR5 (#3583): holdout measurement of arm D and the frozen default-mode
// decision. The decision function is pure and tested on synthetic numbers; the
// script is run for real and must be byte-identical across two runs.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  decideDefaultMode,
  armDDecisions,
  FROZEN_THRESHOLDS,
  CALIBRATOR_CONTRACT,
  measureHoldout,
} = require('../scripts/semantic-model-holdout-eval');
const { runContradictionReport } = require('../lib/cognitive-lab-contradiction-report');
const { joinCorpusLabels } = require('../lib/cognitive-lab-contradiction-evaluator');
const { DEFAULT_MODE } = require('../lib/semantic-model-port');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'semantic-model-holdout-eval.js');
const CORPUS = require('./fixtures/contradiction-eval-v1.corpus.json');
const LABELS = require('./fixtures/contradiction-eval-v1.labels.json');
const SOURCE_COMMIT = 'f58b0716e05eb44cbc64faa8cbbec6037d7e524d';

function passing(overrides = {}) {
  return {
    holdoutScorable: 13,
    coverage: 0.3,
    brier: { mean: 0.02, lower: 0.001 },
    eceDelta: 0.01,
    fprIncrease: 0.01,
    adjudicationStatus: 'ADJUDICATED',
    ...overrides,
  };
}

test('decideDefaultMode promotes only when every frozen threshold passes', () => {
  const result = decideDefaultMode(passing());
  assert.equal(result.decision, 'PROMOTE_ON');
  assert.deepEqual(result.reasons, []);
});

test('decideDefaultMode accepts the exact frozen boundary values', () => {
  const result = decideDefaultMode(passing({
    coverage: 0.1,
    brier: { mean: 0.01, lower: 0.0001 },
    eceDelta: 0.02,
    fprIncrease: 0.02,
  }));
  assert.equal(result.decision, 'PROMOTE_ON');
});

test('decideDefaultMode fails when the Brier CI lower bound is not above zero', () => {
  const result = decideDefaultMode(passing({ brier: { mean: 0.05, lower: 0 } }));
  assert.equal(result.decision, 'STAY_SHADOW');
  assert.deepEqual(result.reasons, ['brier_ci_lower_bound_not_above_0']);
});

test('decideDefaultMode fails when the Brier point improvement is below 0.01', () => {
  const result = decideDefaultMode(passing({ brier: { mean: 0.009, lower: 0.005 } }));
  assert.deepEqual(result.reasons, ['brier_point_improvement_below_0.01']);
});

test('decideDefaultMode fails when ECE degrades beyond 0.02', () => {
  const result = decideDefaultMode(passing({ eceDelta: 0.021 }));
  assert.deepEqual(result.reasons, ['ece_degradation_above_0.02']);
});

test('decideDefaultMode fails when the FPR increase exceeds 0.02', () => {
  const result = decideDefaultMode(passing({ fprIncrease: 0.021 }));
  assert.deepEqual(result.reasons, ['fpr_increase_above_0.02']);
});

test('decideDefaultMode fails when non-abstain coverage is below 0.10', () => {
  const result = decideDefaultMode(passing({ coverage: 0.09 }));
  assert.deepEqual(result.reasons, ['non_abstain_coverage_below_0.10']);
});

test('decideDefaultMode fails when the holdout support is below the sample floor', () => {
  const result = decideDefaultMode(passing({ holdoutScorable: 9 }));
  assert.deepEqual(result.reasons, ['holdout_support_below_floor']);
});

test('decideDefaultMode keeps shadow while adjudication is pending even if numbers pass', () => {
  const result = decideDefaultMode(passing({ adjudicationStatus: 'PENDING_INDEPENDENT_HOLDOUT_REVIEW' }));
  assert.equal(result.decision, 'STAY_SHADOW');
  assert.deepEqual(result.reasons, ['holdout_adjudication_not_adjudicated']);
});

test('decideDefaultMode stays shadow with insufficient support and lists every unmeasured threshold', () => {
  const result = decideDefaultMode({
    holdoutScorable: 13, coverage: 0, brier: null, eceDelta: null, fprIncrease: null,
    adjudicationStatus: 'PENDING_INDEPENDENT_HOLDOUT_REVIEW',
  });
  assert.equal(result.decision, 'STAY_SHADOW');
  assert.deepEqual(result.reasons, [
    'non_abstain_coverage_below_0.10',
    'paired_brier_not_measured',
    'ece_not_measured',
    'fpr_not_measured',
    'holdout_adjudication_not_adjudicated',
  ]);
});

test('frozen thresholds match the R51 preregistration', () => {
  assert.equal(FROZEN_THRESHOLDS.brierLowerBoundAbove, 0);
  assert.equal(FROZEN_THRESHOLDS.brierPointImprovementAtLeast, 0.01);
  assert.equal(FROZEN_THRESHOLDS.eceDegradationAtMost, 0.02);
  assert.equal(FROZEN_THRESHOLDS.fprIncreaseAtMost, 0.02);
  assert.equal(FROZEN_THRESHOLDS.nonAbstainCoverageAtLeast, 0.1);
});

function signal(band, probability = 0.9) {
  return {
    band,
    reason: band === 'ABSTAIN' ? 'calibration_insufficient' : null,
    p: { CONTRADICTION: probability, ENTAILMENT: 0.05, NEUTRAL: 0.05 - probability / 10, ABSTAIN: 0.01 },
  };
}

test('arm D abstains on every pair whose band is ABSTAIN and never scores it', () => {
  const records = [{ pairId: 'p1', label: 'CONTRADICTION' }, { pairId: 'p2', label: 'NOT_CONTRADICTION' }];
  const result = armDDecisions(records, () => signal('ABSTAIN'));
  assert.equal(result.kept.length, 0);
  assert.equal(result.predictions.size, 0);
  assert.deepEqual(result.abstainReasons, { calibration_insufficient: 2 });
});

test('arm D scores only the pairs with a CONFIDENT band', () => {
  const records = [{ pairId: 'p1', label: 'CONTRADICTION' }, { pairId: 'p2', label: 'NOT_CONTRADICTION' }];
  const result = armDDecisions(records, (record) => (record.pairId === 'p1' ? signal('CONFIDENT', 0.8) : signal('ABSTAIN')));
  assert.deepEqual(result.kept.map((record) => record.pairId), ['p1']);
  assert.equal(result.predictions.get('p1').probability, 0.8);
  assert.deepEqual(result.abstainReasons, { calibration_insufficient: 1 });
});

test('the holdout labels never reach the arm B or arm C fits', () => {
  const records = joinCorpusLabels(CORPUS, LABELS);
  const flipped = records.map((record) => {
    if (record.split !== 'holdout') return record;
    if (record.label === 'CONTRADICTION') return { ...record, label: 'NOT_CONTRADICTION' };
    if (record.label === 'NOT_CONTRADICTION') return { ...record, label: 'CONTRADICTION' };
    return record;
  });
  const options = { contract: CALIBRATOR_CONTRACT, threshold: 0.5, sourceCommit: SOURCE_COMMIT };
  const original = runContradictionReport({ records, ...options });
  const changed = runContradictionReport({ records: flipped, ...options });
  const probabilities = (arm) => arm.decisions.map((decision) => [decision.pairId, decision.probability]);
  assert.deepEqual(probabilities(changed.arms.B), probabilities(original.arms.B));
  assert.deepEqual(probabilities(changed.arms.C), probabilities(original.arms.C));
});

test('measureHoldout with an always-abstaining arm D stays shadow and pairs nothing', () => {
  const records = joinCorpusLabels(CORPUS, LABELS);
  const report = measureHoldout({
    records, sourceCommit: SOURCE_COMMIT, signalOf: () => signal('ABSTAIN'), adjudicationStatus: 'PENDING_INDEPENDENT_HOLDOUT_REVIEW',
  });
  assert.equal(report.arms.D.support, 0);
  assert.equal(report.pairedPrimary.result.status, 'INSUFFICIENT');
  assert.equal(report.decision.decision, 'STAY_SHADOW');
});

test('the script output is byte-identical across two runs and records a STAY_SHADOW decision', () => {
  const first = execFileSync(process.execPath, [SCRIPT, `--source-commit=${SOURCE_COMMIT}`], { encoding: 'utf8' });
  const second = execFileSync(process.execPath, [SCRIPT, `--source-commit=${SOURCE_COMMIT}`], { encoding: 'utf8' });
  assert.equal(first, second);
  const parsed = JSON.parse(first);
  assert.equal(parsed.decision.decision, 'STAY_SHADOW');
  assert.equal(DEFAULT_MODE, 'shadow');
});

test('the script refuses to run without a 40-char source commit', () => {
  assert.throws(() => execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8', stdio: 'pipe' }), /usage/);
});

test('R55: the pre-declared LOGISTIC_V2 arm is measured, recorded and still decides STAY_SHADOW', () => {
  const out = execFileSync(process.execPath, [SCRIPT, `--source-commit=${SOURCE_COMMIT}`, '--family=LOGISTIC_V2'], { encoding: 'utf8' });
  assert.equal(out, execFileSync(process.execPath, [SCRIPT, `--source-commit=${SOURCE_COMMIT}`, '--family=LOGISTIC_V2'], { encoding: 'utf8' }));
  const report = JSON.parse(out);
  assert.equal(report.armDFamily, 'LOGISTIC_V2');
  assert.equal(report.decision.decision, 'STAY_SHADOW');
  assert.ok(!report.secondaryFamilies.some(row => row.family === 'LOGISTIC_V2'));
  assert.ok(report.secondaryFamilies.some(row => row.family === 'SSM'));
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, `--source-commit=${SOURCE_COMMIT}`, '--family=GPT'], { encoding: 'utf8', stdio: 'pipe' }), /usage/);
});
