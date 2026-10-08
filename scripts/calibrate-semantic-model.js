#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { LABELS, digest } = require('../lib/semantic-model-artifact');
const { loadSemanticModel } = require('../lib/semantic-model-inference');
const { fitCalibration } = require('../lib/semantic-model-calibration');
const { digestOf, stableStringify } = require('./contradiction-eval-freeze-contract');
const { assertNoHoldoutLeakage } = require('./semantic-teacher-contract');
const { validateTrainingRecord } = require('./train-semantic-model');

const FROZEN_CORPUS = path.join(__dirname, '../test/fixtures/contradiction-eval-v1.corpus.json');

/** Hard calibration target: the consensus soft label's argmax, ties in LABELS order. */
function consensusLabel(distribution) {
  return LABELS.reduce((best, label) => distribution[label] > distribution[best] ? label : best, LABELS[0]);
}

/** Calibration split only; the R50 holdout authority is the repo corpus, not a user file. */
function calibrateSemanticModel(dataset, modelInput, options = {}) {
  const { corpusDigest, ...payload } = dataset || {};
  if (payload.schemaVersion !== 'huqan-semantic-training-v1' || !Array.isArray(payload.records) ||
      corpusDigest !== `sha256:${digestOf(payload)}`) {
    throw new TypeError('semantic_training_digest_mismatch');
  }
  const frozen = JSON.parse(fs.readFileSync(FROZEN_CORPUS, 'utf8')).records;
  assertNoHoldoutLeakage(dataset.records, frozen);
  for (const record of dataset.records) validateTrainingRecord(record);
  const records = dataset.records.filter(record => record.split === 'calibration' && record.weight > 0 && !record.needsReview)
    .sort((a, b) => a.pairDigest < b.pairDigest ? -1 : a.pairDigest > b.pairDigest ? 1 : 0);
  if (!records.length) throw new TypeError('semantic_calibration_input_invalid');
  const model = loadSemanticModel(modelInput);
  return fitCalibration(records.map(record => model.predict(record)), records.map(record => consensusLabel(record.distribution)),
    { ...options, calibrationCorpusDigest: digest(records) });
}

function main(argv) {
  if (argv.length !== 3) throw new TypeError('usage: calibrate-semantic-model dataset.json model-artifact.json output.json');
  const calibration = calibrateSemanticModel(JSON.parse(fs.readFileSync(argv[0], 'utf8')), fs.readFileSync(argv[1], 'utf8'));
  fs.writeFileSync(argv[2], `${stableStringify(calibration)}\n`, { flag: 'wx' });
  return calibration.calibrationDigest;
}
if (require.main === module) {
  try { process.stdout.write(`${main(process.argv.slice(2))}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
module.exports = { calibrateSemanticModel, consensusLabel, main };
