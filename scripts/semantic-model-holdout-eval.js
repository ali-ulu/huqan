#!/usr/bin/env node
'use strict';

/**
 * R51 PR5 (#3583) -- holdout measurement of arm D and the default-mode decision.
 *
 * Arm D is the packaged own-weight model (SSM by default) read through the
 * semantic-model port in `shadow` mode with its packaged calibrator. A pair the
 * port marks `band: ABSTAIN` is abstained on, never scored as a negative. The
 * arms A/B/C come from the R50 report machinery unchanged, so the primary
 * comparison D vs B and the secondary D vs C use the same seed, bootstrap
 * contract and calibration fits as R50.
 *
 * Fit discipline: the only fits are R50's (calibration split for arm B, train +
 * calibration for arm C). Arm D is never fitted; its calibrator is read from the
 * packaged artifact. Holdout records reach only the read-only evaluators.
 *
 * Decision: `decideDefaultMode` applies the frozen PR5 thresholds from
 * docs/task-packs/semantic-model-preregistration-r51.md. Any failed or
 * unmeasurable threshold leaves DEFAULT_MODE `shadow`. This script never edits
 * lib/semantic-model-port.js; a PROMOTE_ON result is applied by hand.
 *
 * Usage: node scripts/semantic-model-holdout-eval.js --source-commit=<40-hex> [--family=<FAMILY>]
 * Prints a deterministic JSON report (no wall-clock, no environment reads).
 */

const fs = require('node:fs');
const path = require('node:path');
const { runContradictionReport, DEFAULT_REPORT_CONTRACT } = require('../lib/cognitive-lab-contradiction-report');
const {
  joinCorpusLabels, contradictionRuleScore, evaluateContradictionArm, PROBABILITY_KIND, SCORABLE_LABELS,
} = require('../lib/cognitive-lab-contradiction-evaluator');
const { pairedCalibrationDelta, PAIRED_STATUS } = require('../lib/cognitive-lab-paired-delta');
const { evaluateSemanticModel } = require('../lib/semantic-model-port');
const {
  createSemanticModelProvider, createSemanticModelCalibrator, DEFAULT_FAMILY, FAMILY_FILES,
} = require('../lib/semantic-model-provider');

const SCHEMA_VERSION = 'huqan-semantic-holdout-eval-v1';
const REPO_ROOT = path.join(__dirname, '..');
const CORPUS_PATH = path.join(REPO_ROOT, 'test', 'fixtures', 'contradiction-eval-v1.corpus.json');
const LABELS_PATH = path.join(REPO_ROOT, 'test', 'fixtures', 'contradiction-eval-v1.labels.json');
// Same calibrator contract as R50 (test/cognitive-lab-contradiction-cli-wiring.test.js).
const CALIBRATOR_CONTRACT = Object.freeze({ minimumSamples: 10, smoothingAlpha: 0.5 });
const THRESHOLD = 0.5;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;

// Frozen in the R51 preregistration ("Donmuş bütçe ve promotion" and R50's sample floor).
const FROZEN_THRESHOLDS = Object.freeze({
  minHoldoutScorable: 10,
  brierLowerBoundAbove: 0,
  brierPointImprovementAtLeast: 0.01,
  eceDegradationAtMost: 0.02,
  fprIncreaseAtMost: 0.02,
  nonAbstainCoverageAtLeast: 0.1,
  requiredAdjudication: 'ADJUDICATED',
});

function isScorable(record) {
  return SCORABLE_LABELS.includes(record.label);
}

/**
 * The frozen PR5 decision. Pure: it reads only the measured numbers. Every
 * failing or unmeasurable threshold is listed; PROMOTE_ON needs none.
 *
 * @param {object} input
 * @param {number} input.holdoutScorable scorable holdout pairs (R50 sample floor applies)
 * @param {number|null} input.coverage D non-abstain share of scorable holdout pairs
 * @param {{mean:number, lower:number}|null} input.brier paired Brier delta, D minus B (positive = D better)
 * @param {number|null} input.eceDelta ECE(D) - ECE(B), positive = D worse
 * @param {number|null} input.fprIncrease FPR(D) - FPR(B) on the paired decisions
 * @param {string} input.adjudicationStatus holdout adjudication state from the label file
 * @returns {{decision:'PROMOTE_ON'|'STAY_SHADOW', reasons:string[]}}
 */
function decideDefaultMode(input) {
  const reasons = [];
  const t = FROZEN_THRESHOLDS;
  if (!(input.holdoutScorable >= t.minHoldoutScorable)) reasons.push('holdout_support_below_floor');
  if (!(input.coverage !== null && input.coverage >= t.nonAbstainCoverageAtLeast)) reasons.push('non_abstain_coverage_below_0.10');
  if (!input.brier) {
    reasons.push('paired_brier_not_measured');
  } else {
    if (!(input.brier.lower > t.brierLowerBoundAbove)) reasons.push('brier_ci_lower_bound_not_above_0');
    if (!(input.brier.mean >= t.brierPointImprovementAtLeast)) reasons.push('brier_point_improvement_below_0.01');
  }
  if (input.eceDelta === null || input.eceDelta === undefined) reasons.push('ece_not_measured');
  else if (input.eceDelta > t.eceDegradationAtMost) reasons.push('ece_degradation_above_0.02');
  if (input.fprIncrease === null || input.fprIncrease === undefined) reasons.push('fpr_not_measured');
  else if (input.fprIncrease > t.fprIncreaseAtMost) reasons.push('fpr_increase_above_0.02');
  if (input.adjudicationStatus !== t.requiredAdjudication) reasons.push('holdout_adjudication_not_adjudicated');
  return Object.freeze({ decision: reasons.length === 0 ? 'PROMOTE_ON' : 'STAY_SHADOW', reasons: Object.freeze(reasons) });
}

/** Port-backed signal for one family; `shadow` mode, packaged calibrator, no env reads. */
function portSignalOf(family) {
  const env = family === DEFAULT_FAMILY ? {} : { HUQAN_SEMANTIC_MODEL_FAMILY: family };
  const provider = createSemanticModelProvider({ env });
  const calibrator = createSemanticModelCalibrator({ env });
  return (record) => evaluateSemanticModel(record.stored, record.incoming, { mode: 'shadow', provider, calibrator });
}

/**
 * Arm D over scorable records. A pair whose signal band is ABSTAIN is abstained
 * on and counted by reason; only non-abstained pairs become decisions.
 *
 * @returns {{ kept: object[], predictions: Map<string, object>, abstainReasons: Record<string, number> }}
 */
function armDDecisions(records, signalOf) {
  const kept = [];
  const predictions = new Map();
  const abstainReasons = {};
  for (const record of records) {
    const signal = signalOf(record);
    if (!signal || signal.band !== 'CONFIDENT' || !signal.p) {
      const reason = (signal && signal.reason) || 'no_signal';
      abstainReasons[reason] = (abstainReasons[reason] || 0) + 1;
      continue;
    }
    const probability = signal.p.CONTRADICTION;
    kept.push(record);
    predictions.set(record.pairId, Object.freeze({ score: probability, probability, probabilityKind: PROBABILITY_KIND.CALIBRATED }));
  }
  return { kept, predictions, abstainReasons };
}

function armFromPredictions(records, predictions) {
  return evaluateContradictionArm({ records, predict: (record) => predictions.get(record.pairId), threshold: THRESHOLD });
}

/** An arm report re-scored from already-measured decisions (no refit). */
function armOverDecisions(arm, records) {
  const byId = new Map(arm.decisions.map((decision) => [decision.pairId, decision]));
  const present = records.filter((record) => byId.has(record.pairId));
  return armFromPredictions(present, new Map([...byId].map(([id, d]) => [id, d])));
}

function toCalibrationRecords(decisions, keep) {
  return decisions.filter((d) => keep.has(d.pairId)).map((d) => Object.freeze({
    decisionId: d.pairId, status: 'observed', probability: d.probability, y: d.y,
  }));
}

function falsePositiveRate(decisions) {
  const negatives = decisions.filter((d) => d.y === 0);
  if (negatives.length === 0) return null;
  return negatives.filter((d) => d.predicted === 1).length / negatives.length;
}

/** Paired comparison (candidate vs baseline, positive Brier delta = candidate better) on a shared key set. */
function pairedOn(baselineArm, candidateArm, keys) {
  const result = pairedCalibrationDelta({
    baseline: toCalibrationRecords(baselineArm.decisions, keys),
    candidate: toCalibrationRecords(candidateArm.decisions, keys),
    contract: DEFAULT_REPORT_CONTRACT,
  });
  const measured = result.status === PAIRED_STATUS.MEASURED;
  return Object.freeze({
    status: result.status,
    reason: result.reason,
    paired: result.measurement.paired,
    brier: measured ? { mean: result.delta.brier.mean, lower: result.delta.brier.lower, upper: result.delta.brier.upper } : null,
    eceDelta: measured ? result.delta.ece.value : null,
  });
}

function summarizeArm(arm) {
  return Object.freeze({
    status: arm.status,
    probabilityKind: arm.probabilityKind,
    support: arm.measurement.support,
    contradiction: arm.measurement.contradiction,
    notContradiction: arm.measurement.notContradiction,
    exclusions: arm.measurement.exclusions,
    confusion: arm.confusion,
    metrics: arm.metrics,
    brier: arm.calibration ? arm.calibration.brier : null,
    ece: arm.calibration ? arm.calibration.ece : null,
  });
}

function countBy(values) {
  const out = {};
  for (const value of values) out[value] = (out[value] || 0) + 1;
  return out;
}

/** Secondary families: abstention and coverage only. Not used for any decision. */
function secondaryFamilyRows(scorable, primaryFamily) {
  return Object.keys(FAMILY_FILES).filter((family) => family !== primaryFamily).map((family) => {
    const { kept, abstainReasons } = armDDecisions(scorable, portSignalOf(family));
    return Object.freeze({
      family,
      label: 'NOT_USED_FOR_DECISION',
      nonAbstainCoverage: scorable.length === 0 ? null : kept.length / scorable.length,
      abstainReasons,
    });
  });
}

/**
 * The full PR5 measurement over joined records. `signalOf` injects the arm-D
 * signal (defaults to the packaged `family` through the port) for tests. R55
 * (#3717) pre-declares `family` before measuring (docs/task-packs/
 * semantic-model-result-r55.md); it is never chosen on the holdout.
 */
function measureHoldout({ records, sourceCommit, family = DEFAULT_FAMILY, signalOf = portSignalOf(family), adjudicationStatus = 'UNKNOWN' }) {
  const base = runContradictionReport({ records, contract: CALIBRATOR_CONTRACT, threshold: THRESHOLD, sourceCommit });
  const holdoutAll = records.filter((record) => record.split === 'holdout');
  const scorable = holdoutAll.filter(isScorable);
  if (!base.arms) {
    return Object.freeze({
      schemaVersion: SCHEMA_VERSION, sourceCommit, baseStatus: base.status, baseReason: base.reason,
      decision: decideDefaultMode({ holdoutScorable: scorable.length, coverage: null, brier: null, eceDelta: null, fprIncrease: null, adjudicationStatus }),
    });
  }
  const { A, B, C } = base.arms;
  const d = armDDecisions(scorable, signalOf);
  const armD = armFromPredictions(d.kept, d.predictions);
  const coverage = scorable.length === 0 ? null : d.kept.length / scorable.length;

  const keys = new Set(d.kept.map((record) => record.pairId));
  const dVsB = pairedOn(B, armD, keys);
  const dVsC = pairedOn(C, armD, keys);
  const fprB = falsePositiveRate(B.decisions.filter((x) => keys.has(x.pairId)));
  const fprD = falsePositiveRate(armD.decisions);
  const fprIncrease = fprB === null || fprD === null ? null : fprD - fprB;
  const primary = Object.freeze({
    holdoutScorable: scorable.length,
    coverage,
    brier: dVsB.brier,
    eceDelta: dVsB.eceDelta,
    fprIncrease,
    adjudicationStatus,
  });

  const silent = scorable.filter((record) => contradictionRuleScore(record).signalCount === 0);
  const silentKeys = new Set(silent.map((record) => record.pairId));
  const silentD = d.kept.filter((record) => silentKeys.has(record.pairId));
  const silentDKeys = new Set(silentD.map((record) => record.pairId));
  const silentArmD = armFromPredictions(silentD, d.predictions);

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    sourceCommit,
    armDFamily: family,
    calibratorContract: CALIBRATOR_CONTRACT,
    comparisonContract: DEFAULT_REPORT_CONTRACT,
    threshold: THRESHOLD,
    holdout: Object.freeze({
      total: holdoutAll.length,
      scorable: scorable.length,
      contradiction: scorable.filter((r) => r.label === 'CONTRADICTION').length,
      notContradiction: scorable.filter((r) => r.label === 'NOT_CONTRADICTION').length,
      excludedLabels: countBy(holdoutAll.filter((r) => !isScorable(r)).map((r) => r.label)),
    }),
    arms: Object.freeze({
      A: summarizeArm(A), B: summarizeArm(B), C: summarizeArm(C), D: summarizeArm(armD),
    }),
    dArmAbstainReasons: d.abstainReasons,
    dNonAbstainCoverage: coverage,
    pairedPrimary: Object.freeze({ baseline: 'B', candidate: 'D', pairs: keys.size, result: dVsB }),
    pairedSecondary: Object.freeze({ baseline: 'C', candidate: 'D', pairs: keys.size, result: dVsC }),
    fpr: Object.freeze({ B: fprB, D: fprD, increase: fprIncrease }),
    r50Reproduced: Object.freeze({ primary: base.comparison.primary.delta.status, finalState: base.finalState }),
    ruleSilentSubset: Object.freeze({
      scorable: silent.length,
      contradiction: silent.filter((r) => r.label === 'CONTRADICTION').length,
      arms: Object.freeze({
        B: summarizeArm(armOverDecisions(B, silent)),
        C: summarizeArm(armOverDecisions(C, silent)),
        D: summarizeArm(silentArmD),
      }),
      pairedDvsB: pairedOn(B, silentArmD, silentDKeys),
      pairedCvsB: pairedOn(B, armOverDecisions(C, silent), silentKeys),
      note: 'rule-silent pairs (no contradiction rule fired); reported, not used for the decision',
    }),
    secondaryFamilies: secondaryFamilyRows(scorable, family),
    decisionInput: primary,
    decision: decideDefaultMode(primary),
  });
}

function parseArgs(argv) {
  const value = (name) => {
    const arg = argv.find((item) => item.startsWith(`--${name}=`));
    return arg ? arg.slice(name.length + 3) : null;
  };
  return { sourceCommit: value('source-commit'), family: value('family') || DEFAULT_FAMILY };
}

function main(argv) {
  const { sourceCommit, family } = parseArgs(argv);
  if (!sourceCommit || !COMMIT_PATTERN.test(sourceCommit) || !Object.hasOwn(FAMILY_FILES, family)) {
    throw new TypeError('usage: node scripts/semantic-model-holdout-eval.js --source-commit=<40-hex> [--family=<FAMILY>]');
  }
  const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'));
  const labels = JSON.parse(fs.readFileSync(LABELS_PATH, 'utf8'));
  const adjudicationStatus = labels.provenance && labels.provenance.adjudication
    ? labels.provenance.adjudication.status : 'UNKNOWN';
  const report = measureHoldout({ records: joinCorpusLabels(corpus, labels), sourceCommit, family, adjudicationStatus });
  return `${JSON.stringify(report, null, 2)}\n`;
}

if (require.main === module) {
  try {
    process.stdout.write(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  SCHEMA_VERSION,
  CALIBRATOR_CONTRACT,
  FROZEN_THRESHOLDS,
  decideDefaultMode,
  armDDecisions,
  measureHoldout,
  portSignalOf,
  main,
};
