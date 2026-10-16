'use strict';

/**
 * R55 PR2 (#3717): pure-JS inference for the own-weight v2 logistic model.
 * Same prediction shape as the v1 inference (lib/semantic-model-inference.js),
 * so the port (#3709) and the calibrator (#3711) consume it unchanged. It is
 * an uncalibrated CANDIDATE_ONLY proposal; ABSTAIN gets a fixed, very low
 * logit because only calibration may abstain.
 */

const { encodeTextPair } = require('./semantic-model-text-features-v2');
const { FAMILY, LEARNED_LABELS, validateArtifactV2, parseArtifactV2 } = require('./semantic-model-artifact-v2');

// Finite (the calibrator rejects non-finite raw scores) and far below any learned logit.
const ABSTAIN_LOGIT = -50;

function scoresFor(weights, dimensions, features) {
  const scores = new Float64Array(LEARNED_LABELS.length);
  for (let i = 0; i < features.indices.length; i++) {
    const index = features.indices[i];
    const value = features.values[i];
    for (let k = 0; k < scores.length; k++) scores[k] += weights[k * dimensions + index] * value;
  }
  return scores;
}

function softmax(scores) {
  const max = Math.max(...scores);
  const exps = Array.from(scores, score => Math.exp(score - max));
  const sum = exps.reduce((total, value) => total + value, 0);
  return exps.map(value => value / sum);
}

/** Load once (digest-verified); every prediction is local pure JS over the sparse v2 features. */
function loadSemanticModelV2(input) {
  const { artifact, weights } = typeof input === 'string' ? parseArtifactV2(input) : validateArtifactV2(input);
  const dimensions = weights.length / LEARNED_LABELS.length;
  return Object.freeze({ artifactDigest: artifact.artifactDigest, family: FAMILY, language: artifact.language,
    predict(record) {
      const features = encodeTextPair(record, { language: artifact.language, hypothesisOnly: artifact.hypothesisOnly });
      const learned = scoresFor(weights, dimensions, features);
      const probabilities = softmax(learned);
      const distribution = Object.freeze({ CONTRADICTION: probabilities[0], ENTAILMENT: probabilities[1],
        NEUTRAL: probabilities[2], ABSTAIN: 0 });
      const label = LEARNED_LABELS[probabilities.indexOf(Math.max(...probabilities))];
      return Object.freeze({ label, distribution, rawScores: Object.freeze([...learned, ABSTAIN_LOGIT]),
        artifactDigest: artifact.artifactDigest, family: FAMILY, calibrated: false, authority: 'CANDIDATE_ONLY' });
    },
  });
}

module.exports = { ABSTAIN_LOGIT, scoresFor, softmax, loadSemanticModelV2 };
