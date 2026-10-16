'use strict';

const { LABELS, validateArtifact, parseArtifact } = require('./semantic-model-artifact');
const { encodeTextPair, STEPS } = require('./semantic-model-text-features');
const FACTORIES = Object.freeze({
  SSM: require('./cognitive-model-local-ssm').createLocalNeuralModel,
  RWKV: require('./cognitive-model-local-rwkv').createLocalRwkvModel,
  MAMBA: require('./cognitive-model-local-mamba').createLocalMambaModel,
  TRANSFORMER: require('./cognitive-model-local-transformer').createLocalTransformerModel,
});

/** Existing family encoder, reproduced from HUQAN's own seeded frozen weights. */
function createEncoder(family, config) {
  if (!Object.hasOwn(FACTORIES, family)) throw new TypeError('semantic_family_unknown');
  return FACTORIES[family](config);
}

/** Shared text skip features plus existing family features and bias; no new model architecture. */
function readoutFeatures(encoder, record) {
  const text = encodeTextPair(record);
  const vector = new Float32Array(STEPS + encoder.reservoir + 1);
  vector.set(text);
  vector.set(encoder.encode(Array.from(text)), STEPS);
  vector[vector.length - 1] = 1;
  return vector;
}

/** Load immutable, digest-verified weights once; each prediction is local pure JS. */
function loadSemanticModel(input) {
  const artifact = typeof input === 'string' ? parseArtifact(input) : validateArtifact(input);
  const encoder = createEncoder(artifact.family, artifact.config);
  if (`sha256:${encoder.describe().weightsDigest}` !== artifact.encoderDigest) {
    throw new TypeError('semantic_encoder_digest_mismatch');
  }
  const weights = artifact.weights.map(row => new Float32Array(row));
  return Object.freeze({ artifactDigest: artifact.artifactDigest, family: artifact.family,
    predict(record) {
      const features = readoutFeatures(encoder, record);
      const scores = weights.map(row => {
        let score = 0;
        for (let i = 0; i < row.length; i++) score += row[i] * features[i];
        if (!Number.isFinite(score)) throw new TypeError('semantic_prediction_nonfinite');
        return score;
      });
      const positive = scores.map(score => Math.max(0, score));
      const sum = positive.reduce((total, score) => total + score, 0);
      const distribution = Object.fromEntries(LABELS.map((label, i) => [label,
        sum > 0 ? positive[i] / sum : label === 'ABSTAIN' ? 1 : 0]));
      const label = LABELS.reduce((best, candidate) => distribution[candidate] > distribution[best] ? candidate : best, 'ABSTAIN');
      return Object.freeze({ label, distribution: Object.freeze(distribution), rawScores: Object.freeze(scores),
        artifactDigest: artifact.artifactDigest, family: artifact.family, calibrated: false, authority: 'CANDIDATE_ONLY' });
    },
  });
}

module.exports = { createEncoder, readoutFeatures, loadSemanticModel };
