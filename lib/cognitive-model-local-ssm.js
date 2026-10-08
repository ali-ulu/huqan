'use strict';

/**
 * Local recurrent neural model (#3474, I6).
 *
 * The first concrete answer to the model-agnostic port: a small deterministic
 * SSM-family sequence model -- a fixed random reservoir (the recurrence) with a
 * closed-form ridge readout (the only trained part). It is local, deterministic
 * and dependency-free, and it declares its kind as SSM through
 * lib/cognitive-model-port.js.
 *
 * The boundary is structural, not a promise. `predict` returns a proposal built
 * by buildProposal, so it can only ever be a CANDIDATE_ONLY object with
 * canonical:false and a declared budget; it carries no verdict, no receipt and
 * no action authority. The recurrence uses a rational saturating activation
 * (`s / (1 + |s|)`) rather than Math.tanh because the latter is not guaranteed
 * bit-identical across platforms and this model's output is hashed.
 *
 * The reservoir weights are drawn from a fixed seeded LCG and frozen at
 * construction, so a given seed always produces the same model and the same
 * answer for the same input. The readout is a closed-form solve over the
 * frozen features -- no gradient loop, no library, no external call.
 */

const { buildProposal, MODEL_AUTHORITY } = require('./cognitive-model-port');
const { digest } = require('./causal/causal-episode-contract');
const {
  DEFAULT_SEED, DEFAULT_RESERVOIR, DEFAULT_RIDGE, DEFAULT_STEPS,
  MAX_RESERVOIR, SCORE_SCALE,
  prng, assertSeed, assertBoundedInteger, assertStep, toInput, activation, ridgeFit,
} = require('./cognitive-model-local-primitives');

function step({ reservoir, weightsIn, weightsRec, leak }, previous, input) {
  const next = new Array(reservoir);
  for (let i = 0; i < reservoir; i++) {
    let sum = leak * previous[i] + weightsIn[i] * input;
    for (let j = 0; j < reservoir; j++) sum += weightsRec[i][j] * previous[j];
    next[i] = activation(sum);
  }
  return next;
}

function encode(stepCount, input, model) {
  let hidden = new Array(model.reservoir).fill(0);
  for (let t = 0; t < stepCount; t++) hidden = step(model, hidden, input[t]);
  return hidden;
}

/**
 * A local recurrent model over bounded state sequences.
 *
 * @param {Object} [options]
 * @param {number} [options.seed] reservoir seed; the same seed reproduces the model
 * @param {number} [options.reservoir] hidden width (1-64)
 * @param {number} [options.ridge] ridge penalty for the closed-form readout
 * @param {number} [options.steps] bounded input length a prediction encodes
 */
function createLocalNeuralModel({ seed = DEFAULT_SEED, reservoir = DEFAULT_RESERVOIR, ridge = DEFAULT_RIDGE, steps = DEFAULT_STEPS } = {}) {
  if (!Number.isFinite(ridge) || ridge < 0) throw new TypeError('ridge must be a finite non-negative number');
  assertSeed(seed);
  assertBoundedInteger(reservoir, 'reservoir', MAX_RESERVOIR);
  assertBoundedInteger(steps, 'steps', 1024);
  const random = prng(seed);
  const weightsRec = Array.from({ length: reservoir }, () => Array.from({ length: reservoir }, () => (random() * 2 - 1) * 0.9));
  const weightsIn = Array.from({ length: reservoir }, () => (random() * 2 - 1) * 1.0);
  const frozen = Object.freeze({ seed, reservoir, ridge, steps, leak: 0.5, weightsRec, weightsIn });
  // The model's identity is its frozen weights, not its source bytes: the
  // weights are what a caller reproduces with the same seed.
  const modelDigest = digest({ weightsRec, weightsIn, leak: frozen.leak });
  let readout = null;
  let trainingSamples = 0;

  /** Deterministic feature vector for one bounded sequence of scalar steps. */
  function features(sequence) {
    if (!Array.isArray(sequence) || sequence.length !== steps) throw new TypeError(`sequence must have exactly ${steps} steps`);
    for (const item of sequence) assertStep(item, 'sequence step');
    return encode(steps, sequence.map(toInput), frozen);
  }

  function scoreFor(vector) {
    if (!readout) throw new Error('local model is not trained');
    let score = readout[reservoir];
    for (let i = 0; i < reservoir; i++) score += readout[i] * vector[i];
    return score;
  }

  return Object.freeze({
    kind: 'SSM',
    seed,
    reservoir,
    steps,
    get trained() { return readout !== null; },
    get trainingSamples() { return trainingSamples; },
    /** Copied features for an offline-trained readout; carries no proposal authority. */
    encode(sequence) { return new Float32Array(features(sequence)); },
    /**
     * Closed-form ridge fit over frozen features. `labels` are bounded values
     * (for a binary task, +/-1); the returned model is the same object.
     */
    train(samples) {
      const fit = ridgeFit({ dimension: reservoir + 1, ridge, samples, features });
      readout = fit.readout;
      trainingSamples = fit.trainingSamples;
      return this;
    },
    /**
     * One candidate proposal. It carries the score as a bounded number and a
     * deterministic confidence in [0, 1]; it is never a verdict.
     */
    predict(sequence) {
      const vector = features(sequence);
      const raw = scoreFor(vector);
      const confidence = Math.min(1, Math.abs(raw));
      const score = Math.round(Math.max(-1, Math.min(1, raw)) * SCORE_SCALE) / SCORE_SCALE;
      return buildProposal({
        schemaVersion: 'huqan-cognitive-model-v1',
        modelId: `local-ssm-${seed}-${reservoir}`,
        kind: 'SSM',
        locality: 'LOCAL',
        modelDigest,
        answer: { label: raw >= 0 ? 'positive' : 'negative', score },
        confidence,
        budget: { modelCalls: 0, tokens: 0, operations: reservoir * reservoir * steps },
      });
    },
    /** Stable description of the frozen model, for the experiment manifest. */
    describe() {
      return Object.freeze({ kind: 'SSM', seed, reservoir, ridge, steps, authority: MODEL_AUTHORITY, locality: 'LOCAL',
        modelDigest, weightsDigest: modelDigest,
        parameters: reservoir * reservoir + reservoir * 2 + reservoir + 1,
        operationsPerPrediction: reservoir * reservoir * steps });
    },
  });
}

module.exports = { createLocalNeuralModel, activation };
