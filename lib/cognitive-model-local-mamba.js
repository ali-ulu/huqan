'use strict';

/**
 * Local Mamba-family candidate (#3474, I6; #3561).
 *
 * Mamba answers the port as a selective state-space recurrence: an input gate
 * writes the current step into a per-channel state, a forget gate decays it, and
 * a skip path carries the step through. It sits between the RWKV chain and the
 * full reservoir: richer per-channel dynamics than RWKV, cheaper than the SSM
 * reservoir's dense recurrence.
 *
 * Like every local family it is deterministic, seeded and dependency-free, and
 * every answer is a CANDIDATE_ONLY proposal with no authority.
 */

const { createLocalFamilyModel } = require('./cognitive-model-local-family');
const { activation } = require('./cognitive-model-local-primitives');

const createLocalMambaModel = createLocalFamilyModel({
  kind: 'MAMBA',
  buildFrozen({ random, reservoir }) {
    return {
      weightsIn: Array.from({ length: reservoir }, () => (random() * 2 - 1) * 1.0),
      gateIn: Array.from({ length: reservoir }, () => (random() * 2 - 1) * 0.9),
      gateForget: Array.from({ length: reservoir }, () => 0.5 + random() * 0.4),
      skip: Array.from({ length: reservoir }, () => (random() * 2 - 1) * 0.5),
    };
  },
  encode({ reservoir, weightsIn, gateIn, gateForget, skip }, input) {
    let state = new Array(reservoir).fill(0);
    let output = new Array(reservoir).fill(0);
    for (let t = 0; t < input.length; t++) {
      const next = new Array(reservoir);
      const read = new Array(reservoir);
      for (let i = 0; i < reservoir; i++) {
        next[i] = activation(gateForget[i] * state[i] + gateIn[i] * input[t]);
        read[i] = next[i] + skip[i] * weightsIn[i] * input[t];
      }
      state = next;
      output = read;
    }
    return output;
  },
  parameters: (reservoir) => reservoir * 4 + reservoir + 1,
  operationsPerPrediction: (reservoir, steps) => reservoir * steps,
});

module.exports = { createLocalMambaModel };
