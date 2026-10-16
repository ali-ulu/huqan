'use strict';

const { stableStringify, sha256Hex } = require('./hash-chain');
const { isPlainObject } = require('./is-plain-object');
const { FEATURE_SPEC_DIGEST, STEPS } = require('./semantic-model-text-features');
const LABELS = Object.freeze(['CONTRADICTION', 'ENTAILMENT', 'NEUTRAL', 'ABSTAIN']);
const FAMILIES = Object.freeze(['SSM', 'RWKV', 'MAMBA', 'TRANSFORMER']);
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const SCHEMA = 'huqan-semantic-model-v1';
const digest = value => `sha256:${sha256Hex(stableStringify(value))}`;
const digestPattern = /^sha256:[a-f0-9]{64}$/;

function exact(value, keys) {
  if (!isPlainObject(value) || Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) {
    throw new TypeError('semantic_artifact_fields_invalid');
  }
}

/** Validate before admitting any external bytes into the own-weight inference path. */
function validateArtifact(artifact) {
  exact(artifact, ['schemaVersion', 'featureSpecDigest', 'trainCorpusDigest', 'teacherSet', 'weightsDigest',
    'sourceCommit', 'family', 'config', 'weights', 'encoderDigest', 'artifactDigest']);
  if (artifact.schemaVersion !== SCHEMA || artifact.featureSpecDigest !== FEATURE_SPEC_DIGEST ||
      !FAMILIES.includes(artifact.family)) throw new TypeError('semantic_artifact_spec_unknown');
  exact(artifact.config, ['seed', 'reservoir', 'ridge', 'steps']);
  const { seed, reservoir, ridge, steps } = artifact.config;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff || !Number.isInteger(reservoir) ||
      reservoir < 1 || reservoir > 64 || !Number.isFinite(ridge) || ridge <= 0 || steps !== STEPS) {
    throw new TypeError('semantic_artifact_config_invalid');
  }
  if (!digestPattern.test(artifact.trainCorpusDigest) || !digestPattern.test(artifact.encoderDigest) ||
      !/^[a-f0-9]{40}$/.test(artifact.sourceCommit)) {
    throw new TypeError('semantic_artifact_provenance_invalid');
  }
  if (!Array.isArray(artifact.teacherSet) || artifact.teacherSet.length < 2 || artifact.teacherSet.length > 64) {
    throw new TypeError('semantic_artifact_teachers_invalid');
  }
  const identities = new Set();
  for (const teacher of artifact.teacherSet) {
    exact(teacher, ['teacherId', 'teacherVersion']);
    if (![teacher.teacherId, teacher.teacherVersion].every(v => typeof v === 'string' && v.trim()) ||
        identities.has(teacher.teacherId)) throw new TypeError('semantic_artifact_teachers_invalid');
    identities.add(teacher.teacherId);
  }
  const width = STEPS + reservoir + 1;
  if (!Array.isArray(artifact.weights) || artifact.weights.length !== LABELS.length ||
      !artifact.weights.every(row => Array.isArray(row) && row.length === width &&
        row.every(value => Number.isFinite(value) && Math.fround(value) === value))) {
    throw new TypeError('semantic_artifact_weights_invalid');
  }
  if (artifact.weightsDigest !== digest(artifact.weights)) throw new TypeError('semantic_weights_digest_mismatch');
  const { artifactDigest, ...payload } = artifact;
  if (artifactDigest !== digest(payload)) throw new TypeError('semantic_artifact_digest_mismatch');
  if (Buffer.byteLength(stableStringify(artifact), 'utf8') > MAX_ARTIFACT_BYTES) {
    throw new TypeError('semantic_artifact_budget_exceeded');
  }
  return Object.freeze({ ...artifact, config: Object.freeze({ ...artifact.config }),
    teacherSet: Object.freeze(artifact.teacherSet.map(teacher => Object.freeze({ ...teacher }))),
    weights: Object.freeze(artifact.weights.map(row => Object.freeze([...row]))) });
}

/** Quantize trained readouts once; canonical bytes never include a clock or latency measurement. */
function buildArtifact({ family, config, weights, trainCorpusDigest, teacherSet, sourceCommit, encoderDigest }) {
  const quantized = weights.map(row => Array.from(new Float32Array(row)));
  const payload = { schemaVersion: SCHEMA, featureSpecDigest: FEATURE_SPEC_DIGEST, trainCorpusDigest,
    teacherSet: [...teacherSet].sort((a, b) => a.teacherId < b.teacherId ? -1 : a.teacherId > b.teacherId ? 1 : 0),
    weightsDigest: digest(quantized), sourceCommit, family, config, encoderDigest, weights: quantized };
  return validateArtifact({ ...payload, artifactDigest: digest(payload) });
}

/** Bound serialized input before parsing; malformed or unknown artifacts are never accepted. */
function parseArtifact(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_ARTIFACT_BYTES) {
    throw new TypeError('semantic_artifact_budget_exceeded');
  }
  return validateArtifact(JSON.parse(text));
}

module.exports = { LABELS, FAMILIES, SCHEMA, MAX_ARTIFACT_BYTES, digest, buildArtifact, validateArtifact, parseArtifact };
