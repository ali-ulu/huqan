'use strict';

/**
 * Local RWKV-family candidate (#3474, I6; #3561).
 *
 * RWKV answers the port as a linear-attention recurrence: a per-channel decay
 * keeps a bounded state, and each step mixes the current input back out. It is
 * the cheapest family here -- one multiply-add chain per channel per step -- and
 * exists so B7 can compare a linear-attention model against SSM, Mamba and a
 * small Transformer on the same frozen task, fixture and budget.
 *
 * Like every local family it is deterministic, seeded and dependency-free: the
 * weights are drawn from the shared PRNG and frozen, the readout is the shared
 * closed-form solve, and every answer is a CANDIDATE_ONLY proposal. It carries
 * no verdict and no authority.
 */

const { createLocalFamilyModel } = require('./cognitive-model-local-family');
const { activation } = require('./cognitive-model-local-primitives');

const createLocalRwkvModel = createLocalFamilyModel({
  kind: 'RWKV',
  buildFrozen({ random, reservoir }) {
    return {
      weightsIn: Array.from({ length: reservoir }, () => (random() * 2 - 1) * 1.0),
      weightsRec: Array.from({ length: reservoir }, () => (random() * 2 - 1) * 0.9),
      decay: Array.from({ length: reservoir }, () => 0.5 + random() * 0.4),
      timeMix: Array.from({ length: reservoir }, () => (random() * 2 - 1) * 0.5),
    };
  },
  encode({ reservoir, weightsIn, weightsRec, decay, timeMix }, input) {
    let state = new Array(reservoir).fill(0);
    let output = new Array(reservoir).fill(0);
    for (let t = 0; t < input.length; t++) {
      const next = new Array(reservoir);
      const mixed = new Array(reservoir);
      for (let i = 0; i < reservoir; i++) {
        next[i] = activation(decay[i] * state[i] + weightsRec[i] * state[i] + weightsIn[i] * input[t]);
        mixed[i] = next[i] + timeMix[i] * weightsIn[i] * input[t];
      }
      state = next;
      output = mixed;
    }
    return output;
  },
  parameters: (reservoir) => reservoir * 4 + reservoir + 1,
  operationsPerPrediction: (reservoir, steps) => reservoir * steps,
});

module.exports = { createLocalRwkvModel };
