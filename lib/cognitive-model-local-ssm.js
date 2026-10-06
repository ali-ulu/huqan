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

const DEFAULT_SEED = 3474;
const DEFAULT_RESERVOIR = 24;
const DEFAULT_RIDGE = 0.5;
const DEFAULT_STEPS = 8;
const MAX_RESERVOIR = 64;
const MAX_FEATURES = 4096;
const MAX_ABS_STEP = 1e6;
const SCORE_SCALE = 1e6;

function prng(seed) {
  let state = (Number(seed) >>> 0) || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function assertBoundedInteger(value, field, max) {
  if (!Number.isInteger(value) || value < 1 || value > max) throw new TypeError(`${field} must be an integer in 1-${max}`);
}

/** A bounded scalar step: a finite number, or a boolean read as 0/1. */
function assertStep(value, field) {
  if (typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_ABS_STEP) return;
  throw new TypeError(`${field} must be a finite number or boolean`);
}

function toInput(value) {
  return value === true ? 1 : value === false ? 0 : value;
}

function activation(sum) {
  // Rational saturating nonlinearity: monotone, bounded to (-1, 1), and built
  // only from IEEE-754 arithmetic so the output hashes identically everywhere.
  return sum / (1 + Math.abs(sum));
}

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

/** Gaussian elimination with partial pivoting; the closed-form ridge solve. */
function solveSystem(matrix, rhs, size) {
  const augmented = matrix.map((row, index) => [...row, rhs[index]]);
  for (let column = 0; column < size; column++) {
    let pivot = column;
    for (let row = column + 1; row < size; row++) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    if (divisor === 0) throw new Error('local model readout is singular');
    for (let j = column; j <= size; j++) augmented[column][j] /= divisor;
    for (let row = 0; row < size; row++) {
      if (row === column) continue;
      const factor = augmented[row][column];
      if (factor === 0) continue;
      for (let j = column; j <= size; j++) augmented[row][j] -= factor * augmented[column][j];
    }
  }
  return augmented.map((row) => row[size]);
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
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new TypeError('seed must be an integer in 0-4294967295');
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
    /**
     * Closed-form ridge fit over frozen features. `labels` are bounded values
     * (for a binary task, +/-1); the returned model is the same object.
     */
    train(samples) {
      if (!Array.isArray(samples) || samples.length === 0) throw new TypeError('training samples are required');
      if (samples.length > MAX_FEATURES) throw new TypeError('training sample budget exceeded');
      const dimension = reservoir + 1;
      const gram = Array.from({ length: dimension }, () => new Array(dimension).fill(0));
      const rhs = new Array(dimension).fill(0);
      for (const sample of samples) {
        if (!sample || typeof sample !== 'object' || !Number.isFinite(sample.label)) throw new TypeError('each sample needs a finite label');
        const vector = features(sample.sequence);
        const row = [...vector, 1];
        for (let i = 0; i < dimension; i++) {
          for (let j = 0; j < dimension; j++) gram[i][j] += row[i] * row[j];
          rhs[i] += row[i] * sample.label;
        }
      }
      for (let i = 0; i < dimension; i++) gram[i][i] += ridge;
      readout = solveSystem(gram, rhs, dimension);
      trainingSamples = samples.length;
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
        modelDigest, weightsDigest: modelDigest });
    },
  });
}

module.exports = { createLocalNeuralModel, activation };
