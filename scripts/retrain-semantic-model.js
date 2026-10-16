#!/usr/bin/env node
'use strict';

/**
 * R51 PR4b (#3583): one offline command for dataset build -> train -> calibrate.
 *
 * Writes a NEW, versioned triple (dataset, model artifact, calibration) into an output directory,
 * named by digest. Existing files are never overwritten: the run refuses before writing anything
 * if any target name already exists. Prints the new digests next to the packaged (previous) ones,
 * so receipts that carry an old digest remain verifiable against the packaged files.
 *
 * It does NOT replace lib/semantic-model-artifacts/*.json. Promoting a new artifact into the
 * packaged runtime is a separate, reviewed step (copy, update package-closure and the
 * reference fixtures in one reviewed commit). Runtime stays own-weights only; no teacher is called here.
 */

const fs = require('node:fs');
const path = require('node:path');
const { stableStringify } = require('./contradiction-eval-freeze-contract');
const { buildTrainingDataset } = require('./semantic-training-dataset');
const { trainSemanticModel } = require('./train-semantic-model');
const { calibrateSemanticModel } = require('./calibrate-semantic-model');
const { FAMILIES } = require('../lib/semantic-model-artifact');

const PACKAGED_DIR = path.join(__dirname, '../lib/semantic-model-artifacts');
const FROZEN_CORPUS = path.join(__dirname, '../test/fixtures/contradiction-eval-v1.corpus.json');

function fail(code) { throw new TypeError(code); }

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

/** Base builder input (records, teachers, sources) plus the review labels from semantic-review-labels.js. */
function mergeInputs(base, reviewLabels) {
  if (!base || !Array.isArray(base.records) || !Array.isArray(base.teachers) || !Array.isArray(base.sources)) {
    fail('retrain_input_invalid');
  }
  return {
    records: [...base.records, ...reviewLabels.records],
    teachers: [...base.teachers, ...reviewLabels.teachers],
    sources: [...base.sources, ...reviewLabels.sources],
  };
}

function retrainSemanticModel({ base, reviewLabels, family, sourceCommit, frozenCorpus }) {
  if (!FAMILIES.includes(family)) fail('retrain_family_invalid');
  const dataset = buildTrainingDataset({ ...mergeInputs(base, reviewLabels), frozenCorpus, sourceCommit });
  const artifact = trainSemanticModel(dataset, { family, sourceCommit });
  const calibration = calibrateSemanticModel(dataset, stableStringify(artifact));
  return { dataset, artifact, calibration };
}

function previousDigests(family) {
  const stem = path.join(PACKAGED_DIR, family.toLowerCase());
  return {
    artifactDigest: readJson(`${stem}.json`).artifactDigest,
    calibrationDigest: readJson(`${stem}.calibration.json`).calibrationDigest,
  };
}

function shortDigest(value) {
  return value.slice('sha256:'.length, 'sha256:'.length + 16);
}

function targetNames(family, { corpusDigest, artifactDigest, calibrationDigest }) {
  const stem = family.toLowerCase();
  return {
    dataset: `${stem}.dataset-${shortDigest(corpusDigest)}.json`,
    model: `${stem}.model-${shortDigest(artifactDigest)}.json`,
    calibration: `${stem}.calibration-${shortDigest(calibrationDigest)}.json`,
  };
}

function writeNewFiles(outDir, files) {
  fs.mkdirSync(outDir, { recursive: true });
  if (files.some(([name]) => fs.existsSync(path.join(outDir, name)))) fail('retrain_output_exists');
  for (const [name, value] of files) fs.writeFileSync(path.join(outDir, name), `${stableStringify(value)}\n`, { flag: 'wx' });
}

function main(argv) {
  if (argv.length !== 5) fail('usage: retrain-semantic-model.js base-input.json review-labels.json FAMILY sourceCommit output-dir');
  const [basePath, reviewPath, family, sourceCommit, outDir] = argv;
  const { dataset, artifact, calibration } = retrainSemanticModel({
    base: readJson(basePath),
    reviewLabels: readJson(reviewPath),
    family,
    sourceCommit,
    frozenCorpus: readJson(FROZEN_CORPUS).records,
  });
  const digests = {
    corpusDigest: dataset.corpusDigest,
    artifactDigest: artifact.artifactDigest,
    calibrationDigest: calibration.calibrationDigest,
  };
  const names = targetNames(family, digests);
  writeNewFiles(outDir, [[names.dataset, dataset], [names.model, artifact], [names.calibration, calibration]]);
  return stableStringify({ family, ...digests, previous: previousDigests(family), files: names });
}

if (require.main === module) {
  try { process.stdout.write(`${main(process.argv.slice(2))}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

module.exports = { retrainSemanticModel, mergeInputs, main };
