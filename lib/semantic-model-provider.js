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
const { loadSemanticModelV2 } = require('./semantic-model-inference-v2');
const { FEATURE_SPEC } = require('./semantic-model-text-features');
const { loadCalibration, applyCalibration } = require('./semantic-model-calibration');
const { registerSemanticModelProvider, ARTIFACT_UNAVAILABLE, INPUT_UNSUPPORTED } = require('./semantic-model-port');
const { detectLanguage } = require('./common-semantic-ir');

const ARTIFACT_DIR = path.join(__dirname, 'semantic-model-artifacts');
// LOGISTIC_V2 (R55, #3717) is opt-in and has one artifact per language
// (logistic-v2-<lang>.json). Each pair is routed by lib/common-semantic-ir.js
// detectLanguage; a language with no artifact (incl. 'unknown') is an
// unsupported input, so the port abstains with the reason and the rules decide.
const PACKAGED_FAMILY_FILES = Object.freeze({ SSM: 'ssm.json', RWKV: 'rwkv.json', MAMBA: 'mamba.json', TRANSFORMER: 'transformer.json' });
const FAMILY_FILES = Object.freeze({ ...PACKAGED_FAMILY_FILES, LOGISTIC_V2: 'logistic-v2-{variant}.json' });
const LANGUAGE_VARIANTS = Object.freeze({ LOGISTIC_V2: Object.freeze(['tr', 'en']) });
const DEFAULT_VARIANT = 'default';
const LOADERS = Object.freeze({ LOGISTIC_V2: loadSemanticModelV2 });
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

function fileFor(family, variant) {
  return FAMILY_FILES[family].replace('{variant}', variant);
}

/** Which artifact of the family answers this pair: one per language, or the single default. */
function variantFor(family, pair) {
  const languages = LANGUAGE_VARIANTS[family];
  if (!languages) return DEFAULT_VARIANT;
  const language = detectLanguage(`${pair.stored.text}\n${pair.incoming.text}`);
  if (!languages.includes(language)) throw unsupported(`language_unsupported:${language}`);
  return language;
}

function loadFamily(family, variant, artifactDir) {
  if (!family) throw unavailable('semantic_family_unknown');
  try {
    const load = LOADERS[family] || loadSemanticModel;
    return load(fs.readFileSync(path.join(artifactDir, fileFor(family, variant)), 'utf8'));
  } catch (error) {
    throw unavailable(error && error.code === 'ENOENT' ? 'semantic_artifact_missing' : String(error && error.message));
  }
}

/** A provider bound to one family and artifact directory; each variant's model (or its load error) is memoized. */
function createSemanticModelProvider({ env = process.env, artifactDir = ARTIFACT_DIR } = {}) {
  const family = resolveFamily(env);
  const loaded = new Map();
  return function predictPair(pair) {
    if (!family) throw unavailable('semantic_family_unknown');
    checkPairText(pair);
    const variant = variantFor(family, pair);
    if (!loaded.has(variant)) {
      try {
        loaded.set(variant, { model: loadFamily(family, variant, artifactDir) });
      } catch (error) {
        loaded.set(variant, { error });
      }
    }
    const entry = loaded.get(variant);
    if (entry.error) throw entry.error;
    const prediction = entry.model.predict(pair);
    return variant === DEFAULT_VARIANT ? prediction : Object.freeze({ ...prediction, variant });
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

function calibrationFile(family, variant) {
  return fileFor(family, variant).replace(/\.json$/, '.calibration.json');
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
  const loaded = new Map();
  return function calibratePrediction(prediction) {
    const variant = prediction.variant || DEFAULT_VARIANT;
    if (!loaded.has(variant)) loaded.set(variant, loadCalibrationFor(family, variant, artifactDir, prediction.artifactDigest));
    const entry = loaded.get(variant);
    if (entry.error) throw entry.error;
    if (!entry.calibration) return null;
    // An unfitted calibration has no temperature worth applying: keep the
    // model's own distribution, abstain, and say why.
    if (entry.calibration.status !== 'fitted') {
      return { distribution: prediction.distribution, band: 'ABSTAIN', reason: 'calibration_insufficient', fitted: false };
    }
    return applyCalibration(prediction, entry.calibration);
  };
}

function loadCalibrationFor(family, variant, artifactDir, modelArtifactDigest) {
  if (!family) return { calibration: null };
  let text;
  try {
    text = fs.readFileSync(path.join(artifactDir, calibrationFile(family, variant)), 'utf8');
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
  PACKAGED_FAMILY_FILES,
  LANGUAGE_VARIANTS,
  DEFAULT_FAMILY,
  createSemanticModelProvider,
  createSemanticModelCalibrator,
  installSemanticModelProvider,
};
