'use strict';

/**
 * Shared factory for the local cognitive model family (#3474, I6).
 *
 * The port is model-agnostic; the *shape* of a local candidate is not. Every
 * family -- SSM, RWKV, Mamba, Transformer -- draws frozen weights from the same
 * seeded PRNG, reduces a bounded sequence to a feature vector, and trains the
 * one shared part: a closed-form linear readout. Only the recurrence, the
 * frozen-weight layout and the parameter/operation counts differ.
 *
 * This factory holds the parts that must not drift between families: the
 * candidate-only boundary (every answer goes through `buildProposal`, so it is
 * `CANDIDATE_ONLY` with `canonical:false`), the determinism contract, the
 * feature/readout plumbing and the budget the model declares. A family supplies
 * its recurrence through a small `spec` and inherits the rest, so a new family
 * cannot accidentally ship a weaker boundary than the others.
 */

const { buildProposal, MODEL_AUTHORITY } = require('./cognitive-model-port');
const { digest } = require('./causal/causal-episode-contract');
const {
  DEFAULT_SEED, DEFAULT_RESERVOIR, DEFAULT_RIDGE, DEFAULT_STEPS,
  MAX_RESERVOIR, SCORE_SCALE,
  prng, assertSeed, assertBoundedInteger, assertStep, toInput, ridgeFit,
} = require('./cognitive-model-local-primitives');

/**
 * @param {Object} options
 * @param {string} options.kind one of the port's MODEL_KINDS
 * @param {(context: {random: () => number, reservoir: number, steps: number}) => object} options.buildFrozen
 *   draws the frozen weights; the returned object is the model's identity
 * @param {(frozen: object, input: number[]) => number[]} options.encode
 *   reduces a bounded input vector to a fixed feature vector
 * @param {(reservoir: number) => number} options.parameters trained parameter count
 * @param {(reservoir: number, steps: number) => number} options.operationsPerPrediction declared cost of one prediction
 * @param {string} [options.modelIdPrefix]
 */
function createLocalFamilyModel({ kind, buildFrozen, encode, parameters, operationsPerPrediction, modelIdPrefix = null }) {
  const prefix = modelIdPrefix || kind.toLowerCase();
  /**
   * @param {Object} [options]
   * @param {number} [options.seed] frozen-weight seed; the same seed reproduces the model
   * @param {number} [options.reservoir] hidden width (1-64)
   * @param {number} [options.ridge] ridge penalty for the closed-form readout
   * @param {number} [options.steps] bounded input length a prediction encodes
   */
  return function create(options = {}) {
    const { seed = DEFAULT_SEED, reservoir = DEFAULT_RESERVOIR, ridge = DEFAULT_RIDGE, steps = DEFAULT_STEPS } = options;
    if (!Number.isFinite(ridge) || ridge < 0) throw new TypeError('ridge must be a finite non-negative number');
    assertSeed(seed);
    assertBoundedInteger(reservoir, 'reservoir', MAX_RESERVOIR);
    assertBoundedInteger(steps, 'steps', 1024);
    const random = prng(seed);
    const frozenWeights = Object.freeze(buildFrozen({ random, reservoir, steps }));
    const frozen = Object.freeze({ seed, reservoir, ridge, steps, ...frozenWeights });
    // The model's identity is its frozen weights, not its source bytes.
    const modelDigest = digest(frozenWeights);
    let readout = null;
    let trainingSamples = 0;

    function features(sequence) {
      if (!Array.isArray(sequence) || sequence.length !== steps) throw new TypeError(`sequence must have exactly ${steps} steps`);
      for (const item of sequence) assertStep(item, 'sequence step');
      return encode(frozen, sequence.map(toInput));
    }

    function scoreFor(vector) {
      if (!readout) throw new Error('local model is not trained');
      let score = readout[reservoir];
      for (let i = 0; i < reservoir; i++) score += readout[i] * vector[i];
      return score;
    }

    return Object.freeze({
      kind,
      seed,
      reservoir,
      steps,
      get trained() { return readout !== null; },
      get trainingSamples() { return trainingSamples; },
      train(samples) {
        const fit = ridgeFit({ dimension: reservoir + 1, ridge, samples, features });
        readout = fit.readout;
        trainingSamples = fit.trainingSamples;
        return this;
      },
      predict(sequence) {
        const vector = features(sequence);
        const raw = scoreFor(vector);
        const confidence = Math.min(1, Math.abs(raw));
        const score = Math.round(Math.max(-1, Math.min(1, raw)) * SCORE_SCALE) / SCORE_SCALE;
        return buildProposal({
          schemaVersion: 'huqan-cognitive-model-v1',
          modelId: `local-${prefix}-${seed}-${reservoir}`,
          kind,
          locality: 'LOCAL',
          modelDigest,
          answer: { label: raw >= 0 ? 'positive' : 'negative', score },
          confidence,
          budget: { modelCalls: 0, tokens: 0, operations: operationsPerPrediction(reservoir, steps) },
        });
      },
      describe() {
        return Object.freeze({ kind, seed, reservoir, ridge, steps, authority: MODEL_AUTHORITY, locality: 'LOCAL',
          modelDigest, weightsDigest: modelDigest,
          parameters: parameters(reservoir),
          operationsPerPrediction: operationsPerPrediction(reservoir, steps) });
      },
    });
  };
}

module.exports = { createLocalFamilyModel };
