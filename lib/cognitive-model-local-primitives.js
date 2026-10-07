'use strict';

/**
 * Shared primitives for the local cognitive model family (#3474, I6).
 *
 * The SSM candidate shipped first and carried these helpers inside it. Adding
 * RWKV, Mamba and Transformer candidates made the duplication a correctness
 * risk: the models must agree bit-for-bit on the seeded PRNG, the saturating
 * activation and the closed-form ridge solve, because their answers are hashed
 * and compared. They live here once instead.
 *
 * Nothing here is model-specific. A model draws its frozen weights from `prng`,
 * runs its own recurrence and reduces the sequence to a feature vector; `ridgeFit`
 * turns labelled feature vectors into the single trained part every family
 * shares -- a closed-form linear readout. There is no gradient loop, no library
 * and no external call.
 *
 * The activation is the rational `s / (1 + |s|)`, not `Math.tanh`: the latter is
 * not guaranteed bit-identical across platforms and these outputs are hashed.
 */

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

/** A seed is the model's identity: reject anything but an unsigned 32-bit integer. */
function assertSeed(seed) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new TypeError('seed must be an integer in 0-4294967295');
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
 * Closed-form ridge fit over frozen features.
 *
 * @param {Object} options
 * @param {number} options.dimension feature width plus the bias column
 * @param {number} options.ridge non-negative penalty added to the Gram diagonal
 * @param {Array} options.samples `{ sequence, label }` with a finite label
 * @param {(sequence: Array) => Array<number>} options.features feature extractor
 * @returns {{ readout: number[], trainingSamples: number }}
 */
function ridgeFit({ dimension, ridge, samples, features }) {
  if (!Array.isArray(samples) || samples.length === 0) throw new TypeError('training samples are required');
  if (samples.length > MAX_FEATURES) throw new TypeError('training sample budget exceeded');
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
  return { readout: solveSystem(gram, rhs, dimension), trainingSamples: samples.length };
}

module.exports = {
  DEFAULT_SEED,
  DEFAULT_RESERVOIR,
  DEFAULT_RIDGE,
  DEFAULT_STEPS,
  MAX_RESERVOIR,
  MAX_FEATURES,
  MAX_ABS_STEP,
  SCORE_SCALE,
  prng,
  assertSeed,
  assertBoundedInteger,
  assertStep,
  toInput,
  activation,
  solveSystem,
  ridgeFit,
};
