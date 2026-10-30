'use strict';

/**
 * #4071 COG-M10 Lab evaluator
 * (`docs/task-packs/cog-m10-curiosity-preregistration-20261030.md` §3, §6, §7).
 *
 * Pure, fail-closed evaluation of an already-executed paired run. The runner
 * supplies, per holdout group and per arm, what the real dream→verify path
 * actually did: how many hypotheses were attempted, how many verified, the
 * summed prediction error, and the mean selected difficulty. This module never
 * executes anything and never opens the holdout itself; it owns only the
 * frozen arithmetic and the label.
 *
 * The corpus is a controlled fixture: a GAIN label here proves the pipeline
 * and the preregistered rules work, not that curiosity improved production.
 * `assertsGain` is therefore false by construction.
 */

const { createPairedSampler, pairedPercentile } = require('./cognitive-lab-paired-delta');
const { isPlainObject } = require('./is-plain-object');

const SCHEMA_VERSION = 'huqan-cognitive-lab-m10-report-v1';
const BOOTSTRAP_SEED = 40710;
const RESAMPLES = 2000;
const DELTA = 0.05;
const MIN_GROUPS = 24;
const Z_ALPHA = 1.96;
const Z_POWER = 0.8416;
const DIFFICULTY_DRIFT_MAX = 0.05;

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const round6 = (value) => Math.round(value * 1e6) / 1e6;

/** Sample standard deviation with the n - 1 denominator (preregistration §5). */
function sampleSd(values) {
  if (!Array.isArray(values) || values.length < 2 || !values.every(Number.isFinite)) throw new TypeError('M10_SD_NEEDS_TWO_FINITE');
  const center = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1));
}

function pairedBootstrap(deltas, { reps = RESAMPLES, seed = BOOTSTRAP_SEED } = {}) {
  const random = createPairedSampler(seed);
  const means = [];
  for (let rep = 0; rep < reps; rep += 1) {
    let sum = 0;
    for (let at = 0; at < deltas.length; at += 1) sum += deltas[Math.floor(random() * deltas.length)];
    means.push(sum / deltas.length);
  }
  means.sort((a, b) => a - b);
  return { mean: mean(deltas), lower: pairedPercentile(means, 0.025), upper: pairedPercentile(means, 0.975), reps, seed };
}
const text = (value) => typeof value === 'string' && value.trim() !== '';
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/** Preregistered group floor: max(24, ceil(((z_0.975 + z_0.80) * sigma / delta)^2)). */
function lockGroupCount(sigma) {
  if (!finite(sigma) || sigma < 0) throw new TypeError('M10_SIGMA_INVALID');
  return Math.max(MIN_GROUPS, Math.ceil(((Z_ALPHA + Z_POWER) * sigma / DELTA) ** 2));
}

const reject = (reasons, extra = {}) => Object.freeze({
  schemaVersion: SCHEMA_VERSION, label: 'REJECT', reasons, assertsGain: false,
  intelligenceGain: 'NOT_MEASURED', evidenceClass: 'controlled-fixture', ...extra,
});
const insufficient = (reasons, extra = {}) => Object.freeze({
  schemaVersion: SCHEMA_VERSION, label: 'INSUFFICIENT', reasons, assertsGain: false,
  intelligenceGain: 'NOT_MEASURED', evidenceClass: 'controlled-fixture', ...extra,
});

function validateManifest(manifest, corpus) {
  if (!isPlainObject(manifest)) return 'invalid_manifest';
  if (manifest.seed !== corpus.seed) return 'manifest_seed_mismatch';
  if (!text(manifest.preregistrationDigest)) return 'missing_preregistration_digest';
  if (!text(manifest.monitoringProbeDigest)) return 'missing_monitoring_probe_digest';
  if (!Array.isArray(manifest.predictorVersions)
    || JSON.stringify(manifest.predictorVersions) !== JSON.stringify(corpus.predictorVersions)) return 'predictor_versions_mismatch';
  if (!Number.isInteger(manifest.nRequired) || manifest.nRequired < MIN_GROUPS) return 'invalid_required_groups';
  return null;
}

function validateRecord(record) {
  if (!isPlainObject(record) || !text(record.sourceGroup)) return 'invalid_record';
  if (!Number.isInteger(record.attempted) || record.attempted < 0) return 'invalid_attempted';
  if (!Number.isInteger(record.verified) || record.verified < 0 || record.verified > record.attempted) return 'invalid_verified';
  if (!finite(record.errorSum) || record.errorSum < 0) return 'invalid_error_sum';
  if (!finite(record.selectedDifficulty) || record.selectedDifficulty < 0 || record.selectedDifficulty > 1) return 'invalid_difficulty';
  return null;
}

/**
 * @param {{corpus: object, manifest: object, executions: object, integrity: object}} input
 * @returns {Readonly<object>} paired report with one preregistered label
 */
function evaluateM10({ corpus, manifest, executions, integrity } = {}) {
  if (!isPlainObject(corpus) || corpus.schemaVersion !== 'huqan-m10-corpus-v1') return reject(['invalid_corpus']);
  if (!Array.isArray(corpus.groups)) return reject(['invalid_corpus_groups']);
  if (!text(corpus.corpusDigest) || !text(corpus.groupDigest)) return reject(['missing_corpus_digest']);
  const manifestProblem = validateManifest(manifest, corpus);
  if (manifestProblem) return reject([manifestProblem]);
  if (!isPlainObject(integrity) || !Number.isInteger(integrity.firewallBypass) || !Number.isInteger(integrity.approvalBypass)
    || integrity.firewallBypass < 0 || integrity.approvalBypass < 0) return reject(['invalid_integrity']);
  if (integrity.firewallBypass > 0 || integrity.approvalBypass > 0) {
    return reject(['firewall_or_approval_bypass'], { integrity: { ...integrity } });
  }
  if (!isPlainObject(executions) || !Array.isArray(executions.candidate) || !Array.isArray(executions.control)) {
    return reject(['invalid_executions']);
  }

  const holdout = new Set(corpus.groups.filter((group) => group.split === 'holdout').map((group) => group.sourceGroup));
  if (holdout.size === 0) return insufficient(['empty_holdout']);
  for (const row of Array.isArray(corpus.monitoringHistory) ? corpus.monitoringHistory : []) {
    if (row && holdout.has(row.sourceGroup)) return reject(['monitoring_history_contains_holdout']);
  }

  const armMaps = {};
  for (const arm of ['candidate', 'control']) {
    const map = new Map();
    for (const record of executions[arm]) {
      const problem = validateRecord(record);
      if (problem) return reject([`${arm}:${problem}`]);
      if (map.has(record.sourceGroup)) return reject([`${arm}:duplicate_group`]);
      if (!holdout.has(record.sourceGroup)) return reject([`${arm}:group_not_in_holdout`]);
      map.set(record.sourceGroup, record);
    }
    armMaps[arm] = map;
  }
  if (armMaps.candidate.size !== armMaps.control.size) return reject(['arm_group_sets_differ']);
  for (const group of armMaps.candidate.keys()) if (!armMaps.control.has(group)) return reject(['arm_group_sets_differ']);

  const paired = [];
  const uncovered = [];
  for (const group of holdout) {
    const candidate = armMaps.candidate.get(group);
    const control = armMaps.control.get(group);
    if (!candidate || !control || candidate.attempted === 0 || control.attempted === 0) {
      uncovered.push(group);
      continue;
    }
    paired.push({ group, candidate, control });
  }
  const coverage = { holdoutGroups: holdout.size, paired: paired.length, uncovered };
  if (paired.length < manifest.nRequired) {
    return insufficient(['paired_groups_below_required'], { nRequired: manifest.nRequired, coverage });
  }

  const errorDeltas = paired.map(({ candidate, control }) =>
    control.errorSum / control.attempted - candidate.errorSum / candidate.attempted);
  const successDeltas = paired.map(({ candidate, control }) =>
    candidate.verified / candidate.attempted - control.verified / control.attempted);
  const errorInterval = pairedBootstrap(errorDeltas, { reps: RESAMPLES, seed: BOOTSTRAP_SEED });
  const successInterval = pairedBootstrap(successDeltas, { reps: RESAMPLES, seed: BOOTSTRAP_SEED });

  const candidateDifficulty = mean(paired.map(({ candidate }) => candidate.selectedDifficulty));
  const controlDifficulty = mean(paired.map(({ control }) => control.selectedDifficulty));
  const difficultyDrift = candidateDifficulty - controlDifficulty;

  const report = {
    schemaVersion: SCHEMA_VERSION,
    seed: corpus.seed, nRequired: manifest.nRequired, pairedGroups: paired.length,
    corpusDigest: corpus.corpusDigest, groupDigest: corpus.groupDigest,
    error: { delta: 'control-minus-candidate', direction: 'lower-error-is-better',
      mean: round6(errorInterval.mean), lower: round6(errorInterval.lower), upper: round6(errorInterval.upper) },
    success: { delta: 'candidate-minus-control', direction: 'higher-success-is-better',
      mean: round6(successInterval.mean), lower: round6(successInterval.lower), upper: round6(successInterval.upper) },
    difficulty: { candidateMean: round6(candidateDifficulty), controlMean: round6(controlDifficulty),
      drift: round6(difficultyDrift), limit: DIFFICULTY_DRIFT_MAX },
    integrity: { firewallBypass: integrity.firewallBypass, approvalBypass: integrity.approvalBypass },
    coverage, evidenceClass: 'controlled-fixture', intelligenceGain: 'NOT_MEASURED', assertsGain: false,
  };
  const harm = () => Object.freeze({ ...report, label: 'HARM', reasons: [
    ...(errorInterval.upper < 0 ? ['error_interval_upper_below_zero'] : []),
    ...(successInterval.upper < 0 ? ['success_interval_upper_below_zero'] : []),
  ] });
  if (errorInterval.upper < 0 || successInterval.upper < 0) return harm();
  if (difficultyDrift < -DIFFICULTY_DRIFT_MAX) {
    return Object.freeze({ ...report, label: 'NOT_CLEARED', reasons: ['difficulty_drift'] });
  }
  if (errorInterval.lower > 0 && successInterval.lower > 0) {
    return Object.freeze({ ...report, label: 'GAIN', reasons: ['error_interval_lower_above_zero', 'success_interval_lower_above_zero'] });
  }
  return Object.freeze({ ...report, label: 'NOT_CLEARED', reasons: ['co_primary_interval_includes_zero'] });
}

module.exports = {
  SCHEMA_VERSION, BOOTSTRAP_SEED, RESAMPLES, DELTA, MIN_GROUPS, DIFFICULTY_DRIFT_MAX,
  lockGroupCount, sampleSd, evaluateM10,
};
