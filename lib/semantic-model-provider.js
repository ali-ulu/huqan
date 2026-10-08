'use strict';

/**
 * Application-side provider for the semantic model port (R51 PR3, #3583).
 *
 * Loads one packaged own-weight artifact (lib/semantic-model-artifacts/) on
 * first use and answers every later pair from memory: pure JS, no network,
 * no teacher, no external model package. HUQAN_SEMANTIC_MODEL_FAMILY picks the
 * family (ssm by default); PR5 decides which family the default becomes.
 *
 * The family is read once, when the provider is created (at runtime start).
 * A load failure is cached for the process lifetime and rethrown as
 * `artifact_unavailable`, so the port reports ABSTAIN with the reason on every
 * call instead of retrying the disk; fixing the artifact needs a restart.
 */

const fs = require('fs');
const path = require('path');
const { loadSemanticModel } = require('./semantic-model-inference');
const { FEATURE_SPEC } = require('./semantic-model-text-features');
const { loadCalibration, applyCalibration } = require('./semantic-model-calibration');
const { registerSemanticModelProvider, ARTIFACT_UNAVAILABLE, INPUT_UNSUPPORTED } = require('./semantic-model-port');

const ARTIFACT_DIR = path.join(__dirname, 'semantic-model-artifacts');
const FAMILY_FILES = Object.freeze({ SSM: 'ssm.json', RWKV: 'rwkv.json', MAMBA: 'mamba.json', TRANSFORMER: 'transformer.json' });
const DEFAULT_FAMILY = 'SSM';

function unavailable(message) {
  const error = new Error(message);
  error.code = ARTIFACT_UNAVAILABLE;
  return error;
}

function unsupported(message) {
  const error = new Error(message);
  error.code = INPUT_UNSUPPORTED;
  return error;
}

function resolveFamily(env) {
  const raw = env && env.HUQAN_SEMANTIC_MODEL_FAMILY;
  const family = raw ? String(raw).trim().toUpperCase() : DEFAULT_FAMILY;
  return Object.hasOwn(FAMILY_FILES, family) ? family : null;
}

function loadFamily(family, artifactDir) {
  if (!family) throw unavailable('semantic_family_unknown');
  try {
    return loadSemanticModel(fs.readFileSync(path.join(artifactDir, FAMILY_FILES[family]), 'utf8'));
  } catch (error) {
    throw unavailable(error && error.code === 'ENOENT' ? 'semantic_artifact_missing' : String(error && error.message));
  }
}

/** A provider bound to one family and artifact directory; the model (or its load error) is memoized. */
function createSemanticModelProvider({ env = process.env, artifactDir = ARTIFACT_DIR } = {}) {
  const family = resolveFamily(env);
  let loaded = null;
  return function predictPair(pair) {
    if (!loaded) {
      try {
        loaded = { model: loadFamily(family, artifactDir) };
      } catch (error) {
        loaded = { error };
      }
    }
    if (loaded.error) throw loaded.error;
    checkPairText(pair);
    return loaded.model.predict(pair);
  };
}

// An input the frozen feature spec cannot encode is a limit, not a model fault;
// naming it keeps receipt audits from reading it as a prediction failure.
function checkPairText(pair) {
  for (const side of ['stored', 'incoming']) {
    const text = pair && pair[side] && pair[side].text;
    if (typeof text !== 'string' || !text.trim()) throw unsupported(`${side}_text_missing`);
    if (text.length > FEATURE_SPEC.maxTextLength) throw unsupported(`${side}_text_too_long`);
  }
}

function calibrationFile(family) {
  return FAMILY_FILES[family].replace(/\.json$/, '.calibration.json');
}

/**
 * R51 PR4 (#3583): the calibrator paired with the provider. It reads the
 * packaged `<family>.calibration.json` once, bound to the model digest of the
 * first prediction it sees. No calibration file means "uncalibrated" (null);
 * a tampered or foreign calibration is cached and rethrown, so the port fails
 * closed to ABSTAIN with `calibration_failed:<code>` on every call.
 */
function createSemanticModelCalibrator({ env = process.env, artifactDir = ARTIFACT_DIR } = {}) {
  const family = resolveFamily(env);
  let loaded = null;
  return function calibratePrediction(prediction) {
    if (!loaded) loaded = loadCalibrationFor(family, artifactDir, prediction.artifactDigest);
    if (loaded.error) throw loaded.error;
    if (!loaded.calibration) return null;
    // An unfitted calibration has no temperature worth applying: keep the
    // model's own distribution, abstain, and say why.
    if (loaded.calibration.status !== 'fitted') {
      return { distribution: prediction.distribution, band: 'ABSTAIN', reason: 'calibration_insufficient', fitted: false };
    }
    return applyCalibration(prediction, loaded.calibration);
  };
}

function loadCalibrationFor(family, artifactDir, modelArtifactDigest) {
  if (!family) return { calibration: null };
  let text;
  try {
    text = fs.readFileSync(path.join(artifactDir, calibrationFile(family)), 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { calibration: null };
    return { error };
  }
  try {
    return { calibration: loadCalibration(text, { modelArtifactDigest }) };
  } catch (error) {
    return { error };
  }
}

function installSemanticModelProvider(options) {
  registerSemanticModelProvider(createSemanticModelProvider(options), {
    calibrator: createSemanticModelCalibrator(options),
  });
}

module.exports = {
  FAMILY_FILES,
  DEFAULT_FAMILY,
  createSemanticModelProvider,
  createSemanticModelCalibrator,
  installSemanticModelProvider,
};
