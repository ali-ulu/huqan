#!/usr/bin/env node
'use strict';

/**
 * R55 PR2 (#3717): offline learner for the own-weight v2 semantic model.
 *
 * Multinomial logistic regression over the sparse `huqan-semantic-text-v2`
 * features, trained with AdaGrad on the teacher soft labels (CONTRADICTION /
 * ENTAILMENT / NEUTRAL; ABSTAIN mass is dropped and the rest renormalised),
 * weighted by each record's consensus weight. Deterministic: records are
 * visited in pairDigest order every epoch, there is no shuffling and no
 * clock, and weights are quantised to float32 once at the end.
 *
 * Input is a PR1 dataset (huqan-semantic-training-v1); the R50 holdout check
 * and the per-record consensus check are the v1 trainer's. Offline only.
 *
 * Usage: node scripts/train-semantic-model-v2.js dataset.json <en|tr> <sourceCommit> output.json
 */

const fs = require('node:fs');
const path = require('node:path');
const { encodeTextPair, FEATURE_SPEC } = require('../lib/semantic-model-text-features-v2');
const { buildArtifactV2, LEARNED_LABELS } = require('../lib/semantic-model-artifact-v2');
const { digestOf, stableStringify } = require('./contradiction-eval-freeze-contract');
const { assertNoHoldoutLeakage } = require('./semantic-teacher-contract');
const { validateTrainingRecord } = require('./train-semantic-model');

const DEFAULTS = Object.freeze({ seed: 3717, epochs: 3, learningRate: 0.2 });
const ADAGRAD_EPSILON = 1e-8;

/** The learning core, shared by the dataset trainer and the SNLI benchmark. */
function createLogisticTrainer({ learningRate = DEFAULTS.learningRate } = {}) {
  const dimensions = FEATURE_SPEC.dimensions;
  const classes = LEARNED_LABELS.length;
  const weights = new Float64Array(classes * dimensions);
  const accumulated = new Float64Array(classes * dimensions);
  const scores = new Float64Array(classes);
  return {
    /** One example: sparse features, a target distribution over the learned labels, a weight in (0, 1]. */
    step(features, target, weight = 1) {
      scores.fill(0);
      for (let i = 0; i < features.indices.length; i++) {
        for (let k = 0; k < classes; k++) scores[k] += weights[k * dimensions + features.indices[i]] * features.values[i];
      }
      let max = -Infinity;
      for (let k = 0; k < classes; k++) max = Math.max(max, scores[k]);
      let sum = 0;
      for (let k = 0; k < classes; k++) { scores[k] = Math.exp(scores[k] - max); sum += scores[k]; }
      for (let k = 0; k < classes; k++) {
        const error = weight * (scores[k] / sum - target[k]);
        if (error === 0) continue;
        for (let i = 0; i < features.indices.length; i++) {
          const index = k * dimensions + features.indices[i];
          const gradient = error * features.values[i];
          accumulated[index] += gradient * gradient;
          weights[index] -= learningRate * gradient / (Math.sqrt(accumulated[index]) + ADAGRAD_EPSILON);
        }
      }
    },
    finish() { return Float32Array.from(weights); },
  };
}

/** Teacher soft label over the learned labels, or null when it is all ABSTAIN. */
function learnedTarget(distribution) {
  const mass = LEARNED_LABELS.reduce((total, label) => total + distribution[label], 0);
  return mass > 0 ? LEARNED_LABELS.map(label => distribution[label] / mass) : null;
}

function trainSemanticModelV2(dataset, { language, sourceCommit, epochs = DEFAULTS.epochs,
  learningRate = DEFAULTS.learningRate, seed = DEFAULTS.seed, frozenCorpus }) {
  const { corpusDigest, ...payload } = dataset || {};
  if (dataset?.schemaVersion !== 'huqan-semantic-training-v1' || corpusDigest !== `sha256:${digestOf(payload)}`) {
    throw new TypeError('semantic_training_digest_mismatch');
  }
  if (!FEATURE_SPEC.languages.includes(language)) throw new TypeError('semantic_v2_language_invalid');
  assertNoHoldoutLeakage(dataset.records, frozenCorpus);
  for (const record of dataset.records) validateTrainingRecord(record);
  const examples = dataset.records
    .filter(record => record.split === 'train' && record.weight > 0 && !record.needsReview)
    .sort((a, b) => a.pairDigest < b.pairDigest ? -1 : a.pairDigest > b.pairDigest ? 1 : 0)
    .map(record => ({ record, target: learnedTarget(record.distribution) }))
    .filter(example => example.target);
  if (!examples.length) throw new TypeError('semantic_training_budget_invalid');
  const encoded = examples.map(({ record, target }) => ({
    features: encodeTextPair(record, { language }), target, weight: record.weight }));
  const trainer = createLogisticTrainer({ learningRate });
  for (let epoch = 0; epoch < epochs; epoch++) {
    for (const example of encoded) trainer.step(example.features, example.target, example.weight);
  }
  const teachers = new Map();
  for (const { record } of examples) for (const teacher of record.teacherSet) teachers.set(teacher.teacherId, teacher);
  return buildArtifactV2({ weights: trainer.finish(), language,
    config: { seed, epochs, learningRate, order: 'pairDigest-ascending' },
    trainCorpusDigest: `sha256:${digestOf(examples.map(({ record }) => record.pairDigest))}`,
    teacherSet: [...teachers.values()], sourceCommit });
}

function main(argv) {
  if (argv.length !== 4) throw new TypeError('usage: train-semantic-model-v2 dataset.json <en|tr> sourceCommit output.json');
  const frozenCorpus = JSON.parse(fs.readFileSync(path.join(__dirname, '../test/fixtures/contradiction-eval-v1.corpus.json'), 'utf8')).records;
  const artifact = trainSemanticModelV2(JSON.parse(fs.readFileSync(argv[0], 'utf8')),
    { language: argv[1], sourceCommit: argv[2], frozenCorpus });
  fs.writeFileSync(argv[3], `${stableStringify(artifact)}\n`, { flag: 'wx' });
  return artifact.artifactDigest;
}

if (require.main === module) {
  try { process.stdout.write(`${main(process.argv.slice(2))}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

module.exports = { DEFAULTS, createLogisticTrainer, learnedTarget, trainSemanticModelV2, main };
