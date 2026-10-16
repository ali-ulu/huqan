'use strict';

/**
 * R50 PR3 — HUQAN-owned deterministic local fusion (issue #3582, roadmap R50).
 *
 * Arm C is the preregistered deterministic feature vector (PR3's feature module)
 * passed through a closed-form ridge readout trained on the train split, then a
 * frozen score-to-probability mapping fit on the calibration split. The raw
 * ridge output is a **score**, never a probability: probability only enters
 * through a calibration artifact, so `rule signal != probability` holds here
 * exactly as it does in PR2.
 *
 * Arm C fits its **own** calibration artifact on the calibration split, from the
 * fusion readout's scores. Reusing the rule-score mapping from PR2 would feed
 * one distribution's score into another distribution's monotone step function;
 * `applyCalibration` would clamp or interpolate and still return a number, so
 * the reported Brier/ECE would not be supported by the fitted mapping. The
 * artifact records that mapping's digest in `calibration.version`, and
 * `fusionProbability` refuses a calibration artifact whose digest does not match,
 * so a different mapping cannot silently re-score the same artifact.
 *
 * Everything that could be chosen after seeing the data is fixed before a fit:
 * the feature order/digest, the ridge penalty, the seed and the training split.
 * The holdout is never read by `fitFusion`; the caller scores it only at final
 * evaluation. The artifact is canonicalized and digested, so the same train and
 * calibration data with the same algorithm produce byte-for-byte the same
 * artifact, and `fusionScore` verifies the digest before reading a score.
 *
 * The output keeps the model-port authority boundary: DETERMINISTIC / LOCAL /
 * CANDIDATE_ONLY / canonical:false, with zero model calls, tokens and external
 * calls. It asserts no semantic discovery and no gain.
 */

const { isPlainObject } = require('./is-plain-object');
const { stableStringify, sha256Hex } = require('./hash-chain');
const { ridgeFit, DEFAULT_RIDGE } = require('./cognitive-model-local-primitives');
const { applyCalibration, fitCalibration, CALIBRATOR_STATUS } = require('./cognitive-lab-contradiction-calibrator');
const { FEATURE_SPEC_VERSION, FEATURE_SPEC_DIGEST, FEATURE_ORDER, extractFeatures } = require('./cognitive-lab-contradiction-features');

const FUSION_SCHEMA_VERSION = 'huqan-contradiction-fusion-artifact-v1';
const FUSION_STATUS = Object.freeze({ MEASURED: 'MEASURED', INSUFFICIENT: 'INSUFFICIENT' });
const FUSION_ALGORITHM = 'ridgeFit';

const AUTHORITY = Object.freeze({
  kind: 'DETERMINISTIC',
  locality: 'LOCAL',
  authority: 'CANDIDATE_ONLY',
  canonical: false,
  modelCalls: 0,
  tokens: 0,
  externalCalls: 0,
});

const MIN_TRAIN_SAMPLES = 10;

const FUSION_ERROR_CODES = Object.freeze({
  INVALID_INPUT: 'fusion_invalid_input',
  INVALID_RIDGE: 'fusion_invalid_ridge',
  INSUFFICIENT_TRAIN: 'fusion_insufficient_train',
  NON_FINITE_SCORE: 'fusion_non_finite_score',
  DIGEST_MISMATCH: 'fusion_digest_mismatch',
  CALIBRATION_MISMATCH: 'fusion_calibration_mismatch',
  LABEL_LEAKAGE: 'fusion_label_leakage',
});

class ContradictionFusionError extends Error {
  constructor(code, path, message) {
    super(message);
    this.name = 'ContradictionFusionError';
    this.code = code;
    this.path = path;
  }
}

function fail(code, path, message) {
  throw new ContradictionFusionError(code, path, message);
}

const SCORABLE_LABELS = Object.freeze(['CONTRADICTION', 'NOT_CONTRADICTION']);

function requireRidge(ridge) {
  if (typeof ridge !== 'number' || !Number.isFinite(ridge) || ridge < 0) {
    fail(FUSION_ERROR_CODES.INVALID_RIDGE, 'ridge', 'ridge must be a finite number >= 0');
  }
  return ridge;
}

// ridgeFit already receives the ordered vector, so the extractor is the identity.
function readoutFeatures(vector) {
  return vector;
}

function trainSamples(records) {
  return records.map((record) => {
    const { vector } = extractFeatures(record);
    return { sequence: vector, label: record.label === 'CONTRADICTION' ? 1 : 0 };
  });
}

/**
 * A record may only enter a fit through the split it belongs to. The evaluator
 * already filters, but the fitter is exported, so the guard lives here too: a
 * holdout record passed as `trainRecords` would otherwise train on the very
 * labels the preregistration seals.
 */
function requireSplit(records, expected, path) {
  for (const [index, record] of records.entries()) {
    // A record without a split cannot be shown to belong here, so it fails
    // closed rather than slipping through the guard.
    if (!record || record.split !== expected) {
      fail(FUSION_ERROR_CODES.LABEL_LEAKAGE, `${path}[${index}].split`,
        `${path} must be the ${expected} split; received ${String(record && record.split)}`);
    }
  }
}

// Raw readout of one already-fitted artifact; shared by scoring and by the
// calibration fit so both read the same function.
function readoutScore(readout, record) {
  const { vector } = extractFeatures(record);
  const row = [...vector, 1];
  let score = 0;
  for (let i = 0; i < row.length; i += 1) score += readout[i] * row[i];
  return score;
}

/**
 * Fit the frozen fusion artifact and its own calibration mapping.
 *
 * The readout is fit on the train split. Its scores on the calibration split
 * then fit a **separate** score-to-probability artifact, so arm C's probability
 * comes from its own distribution rather than from the rule-score mapping. The
 * calibration artifact's digest is recorded in `calibration.version`; scoring
 * refuses any other mapping.
 *
 * @param {object} input
 * @param {ReadonlyArray<object>} input.trainRecords records on the train split
 * @param {ReadonlyArray<object>} input.calibrationRecords records on the calibration split
 * @param {object} input.contract calibrator contract `{ minimumSamples, smoothingAlpha }`
 * @param {number} [input.ridge] ridge penalty (defaults to the local-model default)
 * @param {string} input.sourceCommit the 40-char Git SHA the artifact is pinned to
 * @returns {Readonly<object>} `MEASURED` with `{ artifact, calibration }`, or
 *   `INSUFFICIENT` with `artifact: null` when train or calibration support is
 *   below the locked minimum.
 */
function fitFusion({ trainRecords, calibrationRecords, contract, ridge = DEFAULT_RIDGE, sourceCommit } = {}) {
  if (!Array.isArray(trainRecords)) fail(FUSION_ERROR_CODES.INVALID_INPUT, 'trainRecords', 'trainRecords must be an array');
  if (!Array.isArray(calibrationRecords)) fail(FUSION_ERROR_CODES.INVALID_INPUT, 'calibrationRecords', 'calibrationRecords are required');
  const lockedRidge = requireRidge(ridge);
  if (typeof sourceCommit !== 'string' || !/^[a-f0-9]{40}$/.test(sourceCommit)) {
    fail(FUSION_ERROR_CODES.INVALID_INPUT, 'sourceCommit', 'a 40-char source commit is required');
  }
  requireSplit(trainRecords, 'train', 'trainRecords');
  requireSplit(calibrationRecords, 'calibration', 'calibrationRecords');

  const samples = trainRecords.filter((record) => SCORABLE_LABELS.includes(record.label));
  if (samples.length < MIN_TRAIN_SAMPLES) {
    return Object.freeze({
      schemaVersion: FUSION_SCHEMA_VERSION,
      status: FUSION_STATUS.INSUFFICIENT,
      reason: 'train_below_minimum',
      authority: AUTHORITY,
      artifact: null,
      calibration: null,
    });
  }

  // ridgeFit appends the bias column itself, so the Gram dimension is the
  // feature width plus one.
  const dimension = FEATURE_ORDER.length + 1;
  const { readout, trainingSamples } = ridgeFit({
    dimension,
    ridge: lockedRidge,
    samples: trainSamples(samples),
    features: readoutFeatures,
  });

  // Arm C's probability comes from a mapping fit on arm C's own scores over the
  // calibration split, never from the rule-score artifact PR2 fits.
  const calibrationScores = calibrationRecords
    .filter((record) => SCORABLE_LABELS.includes(record.label))
    .map((record) => Object.freeze({
      decisionId: record.pairId,
      split: 'calibration',
      score: readoutScore(readout, record),
      label: record.label,
    }));
  const calibration = fitCalibration({ records: calibrationScores, contract });
  if (calibration.status !== CALIBRATOR_STATUS.MEASURED) {
    return Object.freeze({
      schemaVersion: FUSION_SCHEMA_VERSION,
      status: FUSION_STATUS.INSUFFICIENT,
      reason: 'calibration_insufficient',
      authority: AUTHORITY,
      artifact: null,
      calibration,
    });
  }

  const body = {
    schemaVersion: FUSION_SCHEMA_VERSION,
    featureSpecVersion: FEATURE_SPEC_VERSION,
    featureSpecDigest: FEATURE_SPEC_DIGEST,
    detectorSourceDigests: Object.freeze({}),
    training: Object.freeze({
      algorithm: FUSION_ALGORITHM,
      ridge: lockedRidge,
      trainCorpusDigest: sha256Hex(stableStringify(samples.map((record) => record.pairId))),
      trainN: trainingSamples,
      readout: Object.freeze([...readout]),
    }),
    calibration: Object.freeze({
      version: calibration.artifact.digest,
      calibrationCorpusDigest: sha256Hex(stableStringify(calibrationRecords.map((record) => record.pairId))),
      calibrationN: calibrationRecords.length,
    }),
    sourceCommit,
  };
  const artifact = Object.freeze({ ...body, digest: sha256Hex(stableStringify(body)) });
  return Object.freeze({
    schemaVersion: FUSION_SCHEMA_VERSION,
    status: FUSION_STATUS.MEASURED,
    reason: 'measured',
    authority: AUTHORITY,
    artifact,
    calibration,
  });
}

function computeFusionDigest(artifact) {
  const { digest, ...body } = artifact;
  return sha256Hex(stableStringify(body));
}

function assertFusionArtifact(artifact) {
  if (!isPlainObject(artifact)) fail(FUSION_ERROR_CODES.INVALID_INPUT, 'artifact', 'artifact is required');
  if (artifact.schemaVersion !== FUSION_SCHEMA_VERSION) fail(FUSION_ERROR_CODES.INVALID_INPUT, 'artifact.schemaVersion', 'unknown fusion artifact schema');
  if (artifact.featureSpecVersion !== FEATURE_SPEC_VERSION || artifact.featureSpecDigest !== FEATURE_SPEC_DIGEST) {
    fail(FUSION_ERROR_CODES.INVALID_INPUT, 'artifact.featureSpecDigest', 'unknown feature spec');
  }
  if (typeof artifact.digest !== 'string' || computeFusionDigest(artifact) !== artifact.digest) {
    fail(FUSION_ERROR_CODES.DIGEST_MISMATCH, 'artifact.digest', 'fusion artifact digest does not match its content');
  }
  if (!isPlainObject(artifact.training) || !Array.isArray(artifact.training.readout)) {
    fail(FUSION_ERROR_CODES.INVALID_INPUT, 'artifact.training.readout', 'fusion artifact needs a readout');
  }
  if (artifact.training.readout.length !== FEATURE_ORDER.length + 1) {
    fail(FUSION_ERROR_CODES.INVALID_INPUT, 'artifact.training.readout', 'readout dimension does not match the frozen feature spec');
  }
  return artifact;
}

/**
 * Raw fusion score for one record. This is a score, not a probability; the
 * caller must map it through the artifact's own calibration to obtain a
 * probability.
 */
function fusionScore(artifact, record) {
  assertFusionArtifact(artifact);
  const score = readoutScore(artifact.training.readout, record);
  if (!Number.isFinite(score)) fail(FUSION_ERROR_CODES.NON_FINITE_SCORE, 'score', 'fusion score is not finite');
  return score;
}

/**
 * Map a raw fusion score to the artifact's frozen probability. The calibration
 * artifact must be the one the fusion artifact was fit against, so a different
 * (even valid) mapping cannot silently re-score the same readout.
 */
function fusionProbability(artifact, record, calibrationArtifact) {
  assertFusionArtifact(artifact);
  if (!isPlainObject(calibrationArtifact) || calibrationArtifact.digest !== artifact.calibration.version) {
    fail(FUSION_ERROR_CODES.CALIBRATION_MISMATCH, 'calibrationArtifact.digest',
      'calibration artifact does not match the one the fusion artifact was fit against');
  }
  return applyCalibration(calibrationArtifact, fusionScore(artifact, record));
}

module.exports = {
  FUSION_SCHEMA_VERSION,
  FUSION_STATUS,
  FUSION_ALGORITHM,
  FUSION_ERROR_CODES,
  AUTHORITY,
  MIN_TRAIN_SAMPLES,
  ContradictionFusionError,
  fitFusion,
  computeFusionDigest,
  fusionScore,
  fusionProbability,
};
