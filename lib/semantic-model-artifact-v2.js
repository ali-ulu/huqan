'use strict';

/**
 * R55 PR2 (#3717): artifact contract for the own-weight v2 semantic model, a
 * multinomial logistic readout over the sparse `huqan-semantic-text-v2`
 * features (lib/semantic-model-text-features-v2.js).
 *
 * Weights are one dense float32 block (label-major: CONTRADICTION, ENTAILMENT,
 * NEUTRAL, each `dimensions` long), stored little-endian as base64 so the
 * canonical JSON stays exact and bounded. ABSTAIN is not learned: the model
 * never emits it on its own, abstention comes from calibration (#3711).
 * Validation is fail-closed; a v1 loader rejects this schema and vice versa.
 */

const { stableStringify, sha256Hex } = require('./hash-chain');
const { isPlainObject } = require('./is-plain-object');
const { FEATURE_SPEC, FEATURE_SPEC_DIGEST } = require('./semantic-model-text-features-v2');

const SCHEMA = 'huqan-semantic-model-v2';
const FAMILY = 'LOGISTIC_V2';
const LEARNED_LABELS = Object.freeze(['CONTRADICTION', 'ENTAILMENT', 'NEUTRAL']);
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const WEIGHT_BYTES = LEARNED_LABELS.length * FEATURE_SPEC.dimensions * 4;
const digest = value => `sha256:${sha256Hex(stableStringify(value))}`;
const digestPattern = /^sha256:[a-f0-9]{64}$/;

function fail(code) { throw new TypeError(code); }

function exact(value, keys, code) {
  if (!isPlainObject(value) || Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) fail(code);
}

function encodeWeights(weights) {
  if (!(weights instanceof Float32Array) || weights.length * 4 !== WEIGHT_BYTES) fail('semantic_v2_weights_invalid');
  const bytes = Buffer.alloc(WEIGHT_BYTES);
  for (let i = 0; i < weights.length; i++) bytes.writeFloatLE(weights[i], i * 4);
  return bytes.toString('base64');
}

function decodeWeights(base64) {
  if (typeof base64 !== 'string') fail('semantic_v2_weights_invalid');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length !== WEIGHT_BYTES || bytes.toString('base64') !== base64) fail('semantic_v2_weights_invalid');
  const weights = new Float32Array(WEIGHT_BYTES / 4);
  for (let i = 0; i < weights.length; i++) {
    weights[i] = bytes.readFloatLE(i * 4);
    if (!Number.isFinite(weights[i])) fail('semantic_v2_weights_invalid');
  }
  return weights;
}

function validateConfig(config) {
  exact(config, ['seed', 'epochs', 'learningRate', 'order'], 'semantic_v2_config_invalid');
  const { seed, epochs, learningRate, order } = config;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff || !Number.isInteger(epochs) || epochs < 1 || epochs > 50 ||
      !Number.isFinite(learningRate) || learningRate <= 0 || learningRate > 10 || order !== 'pairDigest-ascending') {
    fail('semantic_v2_config_invalid');
  }
}

function validateProvenance(artifact) {
  if (!digestPattern.test(artifact.trainCorpusDigest) || !/^[a-f0-9]{40}$/.test(artifact.sourceCommit)) {
    fail('semantic_v2_provenance_invalid');
  }
  if (!Array.isArray(artifact.teacherSet) || artifact.teacherSet.length < 1 || artifact.teacherSet.length > 64) {
    fail('semantic_v2_teachers_invalid');
  }
  const ids = new Set();
  for (const teacher of artifact.teacherSet) {
    exact(teacher, ['teacherId', 'teacherVersion'], 'semantic_v2_teachers_invalid');
    if (![teacher.teacherId, teacher.teacherVersion].every(v => typeof v === 'string' && v.trim()) || ids.has(teacher.teacherId)) {
      fail('semantic_v2_teachers_invalid');
    }
    ids.add(teacher.teacherId);
  }
}

/** Validate before admitting any bytes into the v2 inference path; returns the artifact plus decoded weights. */
function validateArtifactV2(artifact) {
  exact(artifact, ['schemaVersion', 'family', 'featureSpecDigest', 'language', 'hypothesisOnly', 'labels', 'config',
    'trainCorpusDigest', 'teacherSet', 'sourceCommit', 'weightsBase64', 'weightsDigest', 'artifactDigest'], 'semantic_v2_fields_invalid');
  if (artifact.schemaVersion !== SCHEMA || artifact.family !== FAMILY || artifact.featureSpecDigest !== FEATURE_SPEC_DIGEST ||
      !FEATURE_SPEC.languages.includes(artifact.language) || artifact.hypothesisOnly !== false ||
      stableStringify(artifact.labels) !== stableStringify(LEARNED_LABELS)) {
    fail('semantic_v2_spec_unknown');
  }
  validateConfig(artifact.config);
  validateProvenance(artifact);
  if (artifact.weightsDigest !== digest(artifact.weightsBase64)) fail('semantic_v2_weights_digest_mismatch');
  const { artifactDigest, ...payload } = artifact;
  if (artifactDigest !== digest(payload)) fail('semantic_v2_artifact_digest_mismatch');
  const weights = decodeWeights(artifact.weightsBase64);
  return { artifact, weights };
}

/** Canonical artifact from trained float32 weights; no clock or host detail enters the bytes. */
function buildArtifactV2({ weights, language, config, trainCorpusDigest, teacherSet, sourceCommit }) {
  const weightsBase64 = encodeWeights(weights);
  const payload = { schemaVersion: SCHEMA, family: FAMILY, featureSpecDigest: FEATURE_SPEC_DIGEST, language, hypothesisOnly: false,
    labels: [...LEARNED_LABELS], config, trainCorpusDigest,
    teacherSet: [...teacherSet].sort((a, b) => a.teacherId < b.teacherId ? -1 : a.teacherId > b.teacherId ? 1 : 0),
    sourceCommit, weightsBase64, weightsDigest: digest(weightsBase64) };
  const artifact = { ...payload, artifactDigest: digest(payload) };
  validateArtifactV2(artifact);
  return artifact;
}

function parseArtifactV2(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_ARTIFACT_BYTES) fail('semantic_v2_budget_exceeded');
  return validateArtifactV2(JSON.parse(text));
}

module.exports = { SCHEMA, FAMILY, LEARNED_LABELS, MAX_ARTIFACT_BYTES, buildArtifactV2, validateArtifactV2, parseArtifactV2 };
