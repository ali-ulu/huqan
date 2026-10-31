'use strict';

/**
 * #4070 COG-M4 Lab evaluator
 * (`docs/task-packs/cog-m4-retention-preregistration-20261031.md` §3, §6, §7).
 *
 * Pure, fail-closed evaluation of an already-executed paired run. The runner
 * supplies, per holdout group and per arm, what the real consolidate/archive
 * path actually did: the size of the default read set, how many held-out
 * queries still hit their target within k, the query count and the restore
 * rate. This module never executes anything and never opens the holdout
 * itself; it owns only the frozen arithmetic and the label.
 *
 * The corpus is a controlled fixture: a GAIN label here proves the pipeline
 * and the preregistered rules work, not that forgetting helped production.
 * `assertsGain` is therefore false by construction.
 */

const { createPairedSampler, pairedPercentile } = require('./cognitive-lab-paired-delta');
const { digestCorpus, digestGroups } = require('./cognitive-lab-m4-corpus');
const { isPlainObject } = require('./is-plain-object');

const SCHEMA_VERSION = 'huqan-cognitive-lab-m4-report-v1';
const BOOTSTRAP_SEED = 40701;
const RESAMPLES = 2000;
const NON_INFERIORITY_MARGIN = 0.05;
const MIN_GROUPS = 24;
const Z_ALPHA = 1.96;
const Z_POWER = 0.8416;
const DELTA = 0.05;
const RESTORE_RATE_MAX = 0.05;

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const round6 = (value) => Math.round(value * 1e6) / 1e6;
const text = (value) => typeof value === 'string' && value.trim() !== '';
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/** Sample standard deviation with the n - 1 denominator (preregistration §5). */
function sampleSd(values) {
  if (!Array.isArray(values) || values.length < 2 || !values.every(Number.isFinite)) throw new TypeError('M4_SD_NEEDS_TWO_FINITE');
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

/** Preregistered group floor: max(24, ceil(((z_0.975 + z_0.80) * sigma / delta)^2)). */
function lockGroupCount(sigma) {
  if (!finite(sigma) || sigma < 0) throw new TypeError('M4_SIGMA_INVALID');
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
  if (manifest.corpusDigest !== corpus.corpusDigest) return 'corpus_digest_mismatch';
  if (manifest.groupDigest !== corpus.groupDigest) return 'group_digest_mismatch';
  if (manifest.recallK !== corpus.recallK) return 'recall_k_mismatch';
  if (!Number.isInteger(manifest.nRequired) || manifest.nRequired < MIN_GROUPS) return 'invalid_required_groups';
  return null;
}

function validateRecord(record) {
  if (!isPlainObject(record) || !text(record.sourceGroup)) return 'invalid_record';
  if (!Number.isInteger(record.readSetSize) || record.readSetSize < 0) return 'invalid_read_set_size';
  if (!Number.isInteger(record.queries) || record.queries < 1) return 'invalid_queries';
  if (!Number.isInteger(record.recallHits) || record.recallHits < 0 || record.recallHits > record.queries) return 'invalid_recall_hits';
  if (!Number.isInteger(record.archived) || record.archived < 0) return 'invalid_archived';
  if (!Number.isInteger(record.neededArchived) || record.neededArchived < 0 || record.neededArchived > record.archived) {
    return 'invalid_needed_archived';
  }
  if (!Number.isInteger(record.restoreFailures) || record.restoreFailures < 0 || record.restoreFailures > record.archived) {
    return 'invalid_restore_failures';
  }
  return null;
}

/**
 * @param {{corpus: object, manifest: object, executions: object, integrity: object}} input
 * @returns {Readonly<object>} paired report with one preregistered label
 */
function evaluateM4({ corpus, manifest, executions, integrity } = {}) {
  if (!isPlainObject(corpus) || corpus.schemaVersion !== 'huqan-m4-corpus-v1') return reject(['invalid_corpus']);
  // Every element must be a well-shaped plain object before anything digests or
  // filters the array: a null entry, or a group whose `memories`/`queries` is
  // not an array, would otherwise throw inside digestGroups instead of coming
  // back as a REJECT report.
  if (!Array.isArray(corpus.groups) || !corpus.groups.every((group) => isPlainObject(group)
    && text(group.sourceGroup) && text(group.split) && typeof group.risk === 'boolean'
    && Array.isArray(group.memories) && Array.isArray(group.queries)
    && group.memories.every(isPlainObject) && group.queries.every(isPlainObject))) {
    return reject(['invalid_corpus_groups']);
  }
  if (!text(corpus.corpusDigest) || !text(corpus.groupDigest)) return reject(['missing_corpus_digest']);
  // The declared digests are only trusted after they are recomputed from the
  // corpus data itself: a caller that mutates `groups` after construction would
  // otherwise score an altered holdout while the report still carried the
  // original digest. `buildM4Corpus` deep-freezes the groups, so any difference
  // here is a tampered or hand-built corpus, not a legitimate one.
  if (digestCorpus(corpus) !== corpus.corpusDigest) return reject(['corpus_digest_mismatch']);
  if (digestGroups(corpus.groups) !== corpus.groupDigest) return reject(['group_digest_mismatch']);
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

  const holdout = new Map(corpus.groups.filter((group) => group.split === 'holdout').map((group) => [group.sourceGroup, group.queries.length]));
  if (holdout.size === 0) return insufficient(['empty_holdout']);

  const armMaps = {};
  for (const arm of ['candidate', 'control']) {
    const map = new Map();
    for (const record of executions[arm]) {
      const problem = validateRecord(record);
      if (problem) return reject([`${arm}:${problem}`]);
      if (map.has(record.sourceGroup)) return reject([`${arm}:duplicate_group`]);
      if (!holdout.has(record.sourceGroup)) return reject([`${arm}:group_not_in_holdout`]);
      // The recall ratio divides recallHits by `queries`, so a record whose
      // count is smaller than its group's would inflate the ratio. The count is
      // a property of the group, not of the caller, and must match exactly.
      if (record.queries !== holdout.get(record.sourceGroup)) return reject([`${arm}:query_count_mismatch`]);
      map.set(record.sourceGroup, record);
    }
    armMaps[arm] = map;
  }
  if (armMaps.candidate.size !== armMaps.control.size) return reject(['arm_group_sets_differ']);
  for (const group of armMaps.candidate.keys()) if (!armMaps.control.has(group)) return reject(['arm_group_sets_differ']);

  const paired = [];
  const uncovered = [];
  for (const group of holdout.keys()) {
    const candidate = armMaps.candidate.get(group);
    const control = armMaps.control.get(group);
    if (!candidate || !control) {
      uncovered.push(group);
      continue;
    }
    paired.push({ group, candidate, control });
  }
  const coverage = { holdoutGroups: holdout.size, paired: paired.length, uncovered };

  // A record that was archived and did not restore is a non-reversible
  // mutation: the whole run is refused rather than scored. Preregistration §7
  // ranks this REJECT above INSUFFICIENT, so it is checked before the group
  // floor: an incomplete run that already mutated non-reversibly must not be
  // reported as merely under-powered. The rule applies to every archive, so the
  // control arm is checked alongside the candidate.
  for (const { group, candidate, control } of paired) {
    if (candidate.restoreFailures > 0 || control.restoreFailures > 0) {
      return reject(['non_reversible_archive'], { group, coverage });
    }
  }

  if (paired.length < manifest.nRequired) {
    return insufficient(['paired_groups_below_required'], { nRequired: manifest.nRequired, coverage });
  }

  const recallDelta = paired.map(({ candidate, control }) =>
    candidate.recallHits / candidate.queries - control.recallHits / control.queries);
  const shrink = paired.map(({ candidate, control }) => control.readSetSize - candidate.readSetSize);
  const recallInterval = pairedBootstrap(recallDelta, { reps: RESAMPLES, seed: BOOTSTRAP_SEED });
  const archivedTotal = paired.reduce((sum, { candidate }) => sum + candidate.archived, 0);
  const neededArchivedTotal = paired.reduce((sum, { candidate }) => sum + candidate.neededArchived, 0);
  const restoreRate = archivedTotal ? neededArchivedTotal / archivedTotal : 0;

  const report = {
    schemaVersion: SCHEMA_VERSION,
    seed: corpus.seed, nRequired: manifest.nRequired, pairedGroups: paired.length, recallK: corpus.recallK,
    corpusDigest: corpus.corpusDigest, groupDigest: corpus.groupDigest,
    recall: { delta: 'candidate-minus-control', direction: 'higher-recall-is-better',
      mean: round6(recallInterval.mean), lower: round6(recallInterval.lower), upper: round6(recallInterval.upper) },
    shrink: { mean: round6(mean(shrink)), total: shrink.reduce((sum, value) => sum + value, 0) },
    restoreRate: round6(restoreRate), restoreRateMax: RESTORE_RATE_MAX,
    margin: NON_INFERIORITY_MARGIN,
    integrity: { firewallBypass: integrity.firewallBypass, approvalBypass: integrity.approvalBypass },
    coverage, evidenceClass: 'controlled-fixture', intelligenceGain: 'NOT_MEASURED', assertsGain: false,
  };
  const nonInferior = recallInterval.lower > -NON_INFERIORITY_MARGIN;
  const restoresOk = restoreRate <= RESTORE_RATE_MAX;
  if (recallInterval.upper < -NON_INFERIORITY_MARGIN) {
    return Object.freeze({ ...report, label: 'HARM', reasons: ['recall_interval_upper_below_negative_margin'] });
  }
  if (nonInferior && report.shrink.mean > 0 && restoresOk) {
    return Object.freeze({ ...report, label: 'GAIN', reasons: ['recall_non_inferior', 'read_set_shrank', 'restore_rate_within_limit'] });
  }
  const reasons = [];
  if (!nonInferior) reasons.push('recall_not_non_inferior');
  if (!(report.shrink.mean > 0)) reasons.push('read_set_did_not_shrink');
  if (!restoresOk) reasons.push('restore_rate_exceeded');
  return Object.freeze({ ...report, label: 'NOT_CLEARED', reasons });
}

module.exports = {
  SCHEMA_VERSION, BOOTSTRAP_SEED, RESAMPLES, NON_INFERIORITY_MARGIN, MIN_GROUPS, RESTORE_RATE_MAX,
  lockGroupCount, sampleSd, evaluateM4,
};
