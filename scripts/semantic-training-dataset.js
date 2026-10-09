'use strict';

const { pairDigestOf, digestOf, requireExactFields } = require('./contradiction-eval-freeze-contract');
const { labelPair, textPairKey, validateTeacherOutput, assertNoHoldoutLeakage } = require('./semantic-teacher-contract');
const LICENSES = Object.freeze(['CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'MIT', 'Apache-2.0']);
// The HUQAN owner's own usage data (human review decisions made inside HUQAN)
// is not a published dataset and carries no open licence. It is admitted under
// this SPDX LicenseRef, and only for HUQAN's own internal source ids, so an
// external dataset can never use it to bypass the open-licence allow-list.
const INTERNAL_USAGE_LICENSE = 'LicenseRef-HUQAN-Owner-Usage-Data';
const INTERNAL_SOURCE_IDS = Object.freeze(['conflict-review']);

function licenseAdmitted(source) {
  if (LICENSES.includes(source.license)) return true;
  return source.license === INTERNAL_USAGE_LICENSE && INTERNAL_SOURCE_IDS.includes(source.id);
}

function buildTrainingDataset({ records, teachers, sources, frozenCorpus, sourceCommit }) {
  if (!Array.isArray(records) || !records.length || !Array.isArray(teachers) || !Array.isArray(sources)) {
    throw new TypeError('semantic_dataset_invalid');
  }
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new TypeError('semantic_source_commit_invalid');
  if (!Array.isArray(frozenCorpus) || !frozenCorpus.some(record => record.split === 'holdout')) {
    throw new TypeError('semantic_holdout_missing');
  }
  const sourceMap = new Map();
  for (const source of sources) {
    requireExactFields(source, ['id', 'license', 'url', 'attribution'], 'semantic_license_invalid', 'source');
    if (![source.id, source.url, source.attribution].every(value => typeof value === 'string' && value.trim()) ||
        !licenseAdmitted(source) || sourceMap.has(source.id)) throw new TypeError('semantic_license_invalid');
    sourceMap.set(source.id, source);
  }
  assertNoHoldoutLeakage(records, frozenCorpus);
  const pairs = new Map();
  const texts = new Set();
  const groups = new Map();
  for (const record of records) {
    if (!sourceMap.has(record.sourceId) || !['train', 'calibration'].includes(record.split)) throw new TypeError('semantic_record_invalid');
    const pairDigest = pairDigestOf(record);
    const textKey = textPairKey(record);
    if (pairs.has(pairDigest) || texts.has(textKey)) throw new TypeError('semantic_pair_duplicate');
    texts.add(textKey);
    if (record.pairGroupId) {
      if (groups.has(record.pairGroupId) && groups.get(record.pairGroupId) !== record.split) throw new TypeError('semantic_group_split_leakage');
      groups.set(record.pairGroupId, record.split);
    }
    pairs.set(pairDigest, { record, outputs: [] });
  }
  for (const output of teachers) {
    validateTeacherOutput(output);
    const pair = pairs.get(pairDigestOf(output.input));
    if (!pair) throw new TypeError('semantic_teacher_unknown_pair');
    pair.outputs.push(output);
  }
  const labeled = [...pairs.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, pair]) => {
    const label = labelPair(pair.outputs);
    return { ...pair.record, ...label };
  });
  const orderedSources = [...sources].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const artifact = { schemaVersion: 'huqan-semantic-training-v1', sourceCommit, sources: orderedSources,
    holdoutDigest: `sha256:${digestOf(frozenCorpus.filter(record => record.split === 'holdout').map(pairDigestOf).sort())}`,
    records: labeled };
  return { ...artifact, corpusDigest: `sha256:${digestOf(artifact)}` };
}

module.exports = { LICENSES, INTERNAL_USAGE_LICENSE, INTERNAL_SOURCE_IDS, buildTrainingDataset };
