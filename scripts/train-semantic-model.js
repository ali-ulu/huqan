#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { solveSystem, MAX_FEATURES } = require('../lib/cognitive-model-local-primitives');
const { LABELS, buildArtifact, digest } = require('../lib/semantic-model-artifact');
const { STEPS } = require('../lib/semantic-model-text-features');
const { createEncoder, readoutFeatures } = require('../lib/semantic-model-inference');
const { digestOf, pairDigestOf, stableStringify } = require('./contradiction-eval-freeze-contract');
const { assertNoHoldoutLeakage } = require('./semantic-teacher-contract');

/** Recheck each consensus boundary, even when a caller recomputes the outer corpus hash. */
function validateTrainingRecord(record) {
  const { pairDigest, distribution, disagreement, weight, needsReview, teacherSet } = record;
  if (!Array.isArray(teacherSet) || teacherSet.length < 2 || teacherSet.length > 64 ||
      new Set(teacherSet.map(teacher => teacher.teacherId)).size !== teacherSet.length ||
      !teacherSet.every(teacher => [teacher.teacherId, teacher.teacherVersion].every(value => typeof value === 'string' && value.trim()))) {
    throw new TypeError('semantic_training_quorum_invalid');
  }
  if (!distribution || Object.keys(distribution).sort().join('|') !== [...LABELS].sort().join('|') ||
      !LABELS.every(label => Number.isFinite(distribution[label]) && distribution[label] >= 0 && distribution[label] <= 1) ||
      Math.abs(LABELS.reduce((sum, label) => sum + distribution[label], 0) - 1) > 1e-6 ||
      !Number.isFinite(disagreement) || disagreement < 0 || disagreement > 1 ||
      needsReview !== (disagreement > 0.25) || weight !== (needsReview ? 0 : 1 - disagreement) ||
      !['train', 'calibration'].includes(record.split) || pairDigest !== pairDigestOf(record) ||
      record.digest !== `sha256:${digestOf({ pairDigest, distribution, disagreement, weight, needsReview, teacherSet })}`) {
    throw new TypeError('semantic_training_consensus_invalid');
  }
}

/** Offline weighted multi-label ridge fit reuses HUQAN's existing closed-form solver. */
function trainSemanticModel(dataset, { family, sourceCommit, seed = 3583, reservoir = 8, ridge = 0.5 }) {
  const { corpusDigest, ...payload } = dataset;
  if (dataset.schemaVersion !== 'huqan-semantic-training-v1' || corpusDigest !== `sha256:${digestOf(payload)}`) {
    throw new TypeError('semantic_training_digest_mismatch');
  }
  const frozen = JSON.parse(fs.readFileSync(path.join(__dirname, '../test/fixtures/contradiction-eval-v1.corpus.json'), 'utf8')).records;
  assertNoHoldoutLeakage(dataset.records, frozen);
  for (const record of dataset.records) validateTrainingRecord(record);
  const records = dataset.records.filter(record => record.split === 'train' && record.weight > 0 && !record.needsReview)
    .sort((a, b) => a.pairDigest < b.pairDigest ? -1 : a.pairDigest > b.pairDigest ? 1 : 0);
  if (!records.length || records.length > MAX_FEATURES) throw new TypeError('semantic_training_budget_invalid');
  const config = { seed, reservoir, ridge, steps: STEPS };
  const encoder = createEncoder(family, config);
  const width = STEPS + reservoir + 1;
  const gram = Array.from({ length: width }, () => Array(width).fill(0));
  const rhs = LABELS.map(() => Array(width).fill(0));
  const teachers = new Map();
  for (const record of records) {
    if (!Number.isFinite(record.weight) || record.weight > 1 || !LABELS.every(label =>
      Number.isFinite(record.distribution[label]) && record.distribution[label] >= 0 && record.distribution[label] <= 1) ||
      Math.abs(LABELS.reduce((sum, label) => sum + record.distribution[label], 0) - 1) > 1e-6) {
      throw new TypeError('semantic_training_label_invalid');
    }
    for (const teacher of record.teacherSet) {
      if (teachers.has(teacher.teacherId) && teachers.get(teacher.teacherId).teacherVersion !== teacher.teacherVersion) {
        throw new TypeError('semantic_training_teacher_version_conflict');
      }
      teachers.set(teacher.teacherId, teacher);
    }
    const vector = readoutFeatures(encoder, record);
    for (let i = 0; i < width; i++) {
      for (let j = 0; j < width; j++) gram[i][j] += record.weight * vector[i] * vector[j];
      for (let label = 0; label < LABELS.length; label++) rhs[label][i] += record.weight * vector[i] * record.distribution[LABELS[label]];
    }
  }
  for (let i = 0; i < width; i++) gram[i][i] += ridge;
  return buildArtifact({ family, config, weights: rhs.map(target => solveSystem(gram, target, width)),
    trainCorpusDigest: digest(records), teacherSet: [...teachers.values()], sourceCommit,
    encoderDigest: `sha256:${encoder.describe().weightsDigest}` });
}

function main(argv) {
  if (argv.length !== 4) throw new TypeError('usage: train-semantic-model dataset.json FAMILY sourceCommit output.json');
  const artifact = trainSemanticModel(JSON.parse(fs.readFileSync(argv[0], 'utf8')), { family: argv[1], sourceCommit: argv[2] });
  fs.writeFileSync(argv[3], `${stableStringify(artifact)}\n`, { flag: 'wx' });
  return artifact.artifactDigest;
}
if (require.main === module) {
  try { process.stdout.write(`${main(process.argv.slice(2))}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
module.exports = { trainSemanticModel, main };
