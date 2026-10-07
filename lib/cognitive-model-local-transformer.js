'use strict';

/**
 * Local small-Transformer candidate (#3474, I6; #3561).
 *
 * The Transformer answers the port with a single bounded self-attention block:
 * a per-position projection is attended over the whole sequence with a fixed
 * softmax-free weighting, then reduced to a feature vector. It is the most
 * expensive family here -- attention is quadratic in the step count -- and it is
 * included as the comparison's upper bound on cost.
 *
 * Like every local family it is deterministic, seeded and dependency-free, and
 * every answer is a CANDIDATE_ONLY proposal with no authority. The attention
 * weighting is built only from IEEE-754 arithmetic so the output hashes
 * identically across platforms.
 */

const { createLocalFamilyModel } = require('./cognitive-model-local-family');
const { activation } = require('./cognitive-model-local-primitives');

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

const createLocalTransformerModel = createLocalFamilyModel({
  kind: 'TRANSFORMER',
  buildFrozen({ random, reservoir }) {
    return {
      query: Array.from({ length: reservoir }, () => Array.from({ length: reservoir }, () => (random() * 2 - 1) * 0.9)),
      key: Array.from({ length: reservoir }, () => Array.from({ length: reservoir }, () => (random() * 2 - 1) * 0.9)),
      value: Array.from({ length: reservoir }, () => Array.from({ length: reservoir }, () => (random() * 2 - 1) * 0.9)),
      embed: Array.from({ length: reservoir }, () => (random() * 2 - 1) * 1.0),
    };
  },
  encode({ reservoir, query, key, value, embed }, input) {
    const positions = input.map((token) => {
      const projected = new Array(reservoir);
      for (let i = 0; i < reservoir; i++) projected[i] = activation(embed[i] * token);
      return projected;
    });
    const output = new Array(reservoir).fill(0);
    for (let t = 0; t < positions.length; t++) {
      const q = query.map((row) => dot(row, positions[t]));
      for (let j = 0; j < positions.length; j++) {
        const k = key.map((row) => dot(row, positions[j]));
        const weight = activation(dot(q, k));
        const v = value.map((row) => dot(row, positions[j]));
        for (let i = 0; i < reservoir; i++) output[i] += weight * v[i];
      }
    }
    return output;
  },
  parameters: (reservoir) => reservoir * reservoir * 3 + reservoir + 1,
  operationsPerPrediction: (reservoir, steps) => reservoir * reservoir * steps * steps,
});

module.exports = { createLocalTransformerModel };
