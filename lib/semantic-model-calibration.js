'use strict';

/**
 * R51 PR4a (#3583): post-hoc calibration and ABSTAIN band for the own-weight
 * semantic model. Pure and deterministic; learned only on the calibration split.
 *
 * Method: temperature scaling of the model's rawScores, T chosen by a fixed
 * log-spaced grid minimizing multi-class negative log-likelihood. One scalar
 * parameter is the least data-hungry calibrator (histogram binning needs many
 * points per bin), it cannot reorder classes, so accuracy is untouched, and a
 * fixed grid has no optimizer state, step size or random restart to replay.
 *
 * Fail-closed: below a pre-declared sample floor the artifact records
 * status 'insufficient' and every application returns band ABSTAIN. Brier/ECE
 * are the top-label metrics of lib/cognitive-lab-probability-calibration.js.
 */

const { stableStringify, sha256Hex } = require('./hash-chain');
const { isPlainObject } = require('./is-plain-object');
const { calibrate, MIN_OBSERVED_RECORDS } = require('./cognitive-lab-probability-calibration');
const { LABELS, FAMILIES: V1_FAMILIES } = require('./semantic-model-artifact');
const { FAMILY: V2_FAMILY } = require('./semantic-model-artifact-v2');
// R55 (#3717): the v2 logistic model is calibrated by the same contract as the v1 families.
const FAMILIES = Object.freeze([...V1_FAMILIES, V2_FAMILY]);

const SCHEMA = 'huqan-semantic-calibration-v1';
const METHOD = 'temperature-grid-nll';
// Ten records is the shared calibration lib's floor for a Brier score; a four-class
// temperature plus a selective-accuracy cut needs more, so the frozen floor is 50.
const MIN_CALIBRATION_RECORDS = Math.max(50, MIN_OBSERVED_RECORDS);
const TARGET_ACCURACY = 0.9;
const MIN_CONFIDENT = 10;
// T = 10^(i/20) for i in [-60, 20]: 0.001 .. 10, 81 points, 12 significant digits.
const TEMPERATURE_GRID = Object.freeze(Array.from({ length: 81 },
  (_, i) => Number((10 ** ((i - 60) / 20)).toPrecision(12))));
const PRECISION = 12;
const MAX_CALIBRATION_BYTES = 64 * 1024;
const digest = value => `sha256:${sha256Hex(stableStringify(value))}`;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const round = value => Number(value.toFixed(PRECISION));

function fail(code) { throw new TypeError(code); }

function argmax(distribution) {
  return LABELS.reduce((best, label) => distribution[label] > distribution[best] ? label : best, 'ABSTAIN');
}

function softmax(rawScores, temperature) {
  if (!Array.isArray(rawScores) && !ArrayBuffer.isView(rawScores)) fail('semantic_calibration_prediction_invalid');
  if (rawScores.length !== LABELS.length || !Array.from(rawScores).every(Number.isFinite)) {
    fail('semantic_calibration_prediction_invalid');
  }
  const scaled = Array.from(rawScores, score => score / temperature);
  const max = Math.max(...scaled);
  const exps = scaled.map(score => Math.exp(score - max));
  const sum = exps.reduce((total, value) => total + value, 0);
  return Object.fromEntries(LABELS.map((label, i) => [label, exps[i] / sum]));
}

/** Top-label Brier/ECE through the shared calibration lib; y = the top label was right. */
function topLabelMetrics(distributions, labels) {
  const records = distributions.map((distribution, i) => {
    const label = argmax(distribution);
    return { decisionId: String(i), status: 'observed', probability: Math.min(1, Math.max(0, distribution[label])),
      y: label === labels[i] ? 1 : 0 };
  });
  const result = calibrate(records);
  return { brier: round(result.brier), ece: round(result.ece), n: records.length };
}

function nll(predictions, labels, temperature) {
  let total = 0;
  for (let i = 0; i < predictions.length; i++) {
    total -= Math.log(Math.max(softmax(predictions[i].rawScores, temperature)[labels[i]], 1e-300));
  }
  return total / predictions.length;
}

/** Largest high-confidence prefix whose accuracy reaches the target; the rest abstains. */
function abstainUpper(distributions, labels) {
  const points = distributions.map((distribution, i) => {
    const label = argmax(distribution);
    return { p: distribution[label], correct: label === labels[i] && label !== 'ABSTAIN' };
  }).sort((a, b) => b.p - a.p);
  let upper = 1;
  let correct = 0;
  for (let k = 1; k <= points.length; k++) {
    correct += points[k - 1].correct ? 1 : 0;
    const cut = k === points.length || points[k].p < points[k - 1].p;
    if (cut && k >= MIN_CONFIDENT && correct / k >= TARGET_ACCURACY) upper = k === points.length ? 0 : points[k].p;
  }
  return round(upper);
}

function checkInputs(predictions, labels, calibrationCorpusDigest) {
  if (!Array.isArray(predictions) || !Array.isArray(labels) || !predictions.length ||
      predictions.length !== labels.length) fail('semantic_calibration_input_invalid');
  if (!digestPattern.test(calibrationCorpusDigest)) fail('semantic_calibration_corpus_digest_invalid');
  const { artifactDigest, family } = predictions[0];
  if (!digestPattern.test(artifactDigest) || !FAMILIES.includes(family)) fail('semantic_calibration_prediction_invalid');
  for (let i = 0; i < predictions.length; i++) {
    if (predictions[i].artifactDigest !== artifactDigest || predictions[i].family !== family) {
      fail('semantic_calibration_model_mixed');
    }
    if (!LABELS.includes(labels[i])) fail('semantic_calibration_label_invalid');
    const { distribution } = predictions[i];
    if (!distribution || !LABELS.every(label => Number.isFinite(distribution[label]) &&
      distribution[label] >= 0 && distribution[label] <= 1)) fail('semantic_calibration_prediction_invalid');
    softmax(predictions[i].rawScores, 1);
  }
  return { artifactDigest, family };
}

/** Fit on calibration-split predictions only; never pass R50 holdout predictions here. */
function fitCalibration(predictions, labels, { calibrationCorpusDigest, minRecords = MIN_CALIBRATION_RECORDS } = {}) {
  const { artifactDigest, family } = checkInputs(predictions, labels, calibrationCorpusDigest);
  if (!Number.isInteger(minRecords) || minRecords < MIN_CALIBRATION_RECORDS) fail('semantic_calibration_min_records_invalid');
  const n = predictions.length;
  const sufficient = n >= minRecords;
  let temperature = 1;
  if (sufficient) {
    let best = Infinity;
    for (const candidate of TEMPERATURE_GRID) {
      const loss = nll(predictions, labels, candidate);
      if (loss < best) { best = loss; temperature = candidate; }
    }
  }
  const calibrated = predictions.map(prediction => softmax(prediction.rawScores, temperature));
  const payload = { schemaVersion: SCHEMA, method: METHOD, modelArtifactDigest: artifactDigest, family,
    calibrationCorpusDigest, status: sufficient ? 'fitted' : 'insufficient',
    reason: sufficient ? 'fitted' : 'sample_below_minimum',
    params: { temperature, minRecords, targetAccuracy: TARGET_ACCURACY, minConfident: MIN_CONFIDENT },
    metrics: topLabelMetrics(calibrated, labels),
    uncalibratedMetrics: topLabelMetrics(predictions.map(prediction => prediction.distribution), labels),
    abstainBand: { lower: 0, upper: sufficient ? abstainUpper(calibrated, labels) : 1 } };
  return loadCalibration({ ...payload, calibrationDigest: digest(payload) }, { modelArtifactDigest: artifactDigest });
}

function exact(value, keys, code) {
  if (!isPlainObject(value) || Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) fail(code);
}

function checkMetrics(metrics) {
  exact(metrics, ['brier', 'ece', 'n'], 'semantic_calibration_fields_invalid');
  if (!Number.isFinite(metrics.brier) || !Number.isFinite(metrics.ece) || !Number.isInteger(metrics.n) || metrics.n < 1) {
    fail('semantic_calibration_params_invalid');
  }
}

/** Validate before use: tampered, foreign-model, unknown or non-finite calibrations never load. */
function loadCalibration(input, { modelArtifactDigest } = {}) {
  if (typeof input === 'string' && Buffer.byteLength(input, 'utf8') > MAX_CALIBRATION_BYTES) {
    fail('semantic_calibration_budget_exceeded');
  }
  const value = typeof input === 'string' ? JSON.parse(input) : input;
  exact(value, ['schemaVersion', 'method', 'modelArtifactDigest', 'family', 'calibrationCorpusDigest', 'status',
    'reason', 'params', 'metrics', 'uncalibratedMetrics', 'abstainBand', 'calibrationDigest'], 'semantic_calibration_fields_invalid');
  if (value.schemaVersion !== SCHEMA || value.method !== METHOD || !FAMILIES.includes(value.family) ||
      !['fitted', 'insufficient'].includes(value.status)) fail('semantic_calibration_spec_unknown');
  const { calibrationDigest, ...payload } = value;
  if (calibrationDigest !== digest(payload)) fail('semantic_calibration_digest_mismatch');
  if (!digestPattern.test(modelArtifactDigest || '') || value.modelArtifactDigest !== modelArtifactDigest) {
    fail('semantic_calibration_model_mismatch');
  }
  exact(value.params, ['temperature', 'minRecords', 'targetAccuracy', 'minConfident'], 'semantic_calibration_fields_invalid');
  exact(value.abstainBand, ['lower', 'upper'], 'semantic_calibration_fields_invalid');
  const { temperature, minRecords, targetAccuracy, minConfident } = value.params;
  const { lower, upper } = value.abstainBand;
  if (!Number.isFinite(temperature) || temperature <= 0 || !Number.isInteger(minRecords) || minRecords < MIN_CALIBRATION_RECORDS ||
      !Number.isFinite(targetAccuracy) || !Number.isInteger(minConfident) || !Number.isFinite(lower) ||
      !Number.isFinite(upper) || lower < 0 || upper > 1 || lower > upper) fail('semantic_calibration_params_invalid');
  checkMetrics(value.metrics);
  checkMetrics(value.uncalibratedMetrics);
  return Object.freeze({ ...value, params: Object.freeze({ ...value.params }), metrics: Object.freeze({ ...value.metrics }),
    uncalibratedMetrics: Object.freeze({ ...value.uncalibratedMetrics }), abstainBand: Object.freeze({ lower, upper }) });
}

/** Calibrated candidate distribution plus a band; insufficient calibration always abstains. */
function applyCalibration(prediction, calibration) {
  if (!prediction || prediction.artifactDigest !== calibration.modelArtifactDigest) fail('semantic_calibration_model_mismatch');
  const distribution = Object.freeze(softmax(prediction.rawScores, calibration.params.temperature));
  const label = argmax(distribution);
  const p = distribution[label];
  const { lower, upper } = calibration.abstainBand;
  const reason = calibration.status !== 'fitted' ? 'calibration_insufficient'
    : label === 'ABSTAIN' ? 'abstain_label' : p >= lower && p <= upper ? 'inside_abstain_band' : null;
  return Object.freeze({ distribution, label, p, band: reason ? 'ABSTAIN' : 'CONFIDENT', reason,
    calibrated: true, calibrationDigest: calibration.calibrationDigest });
}

module.exports = { SCHEMA, METHOD, MIN_CALIBRATION_RECORDS, TEMPERATURE_GRID, topLabelMetrics,
  fitCalibration, loadCalibration, applyCalibration };
