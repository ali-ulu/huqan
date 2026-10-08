'use strict';

/**
 * Contradiction rule-score -> P(contradiction) calibrator (#3582, R50 PR2).
 *
 * The contradiction detectors emit a raw rule score (a `severity`) and a
 * hand-written `confidence`. Those confidences are DECLARED_HEURISTIC values,
 * never calibrated outcome probabilities -- `lib/cognitive-lab-probability-
 * calibration.js` already states that rule. This module owns the one missing
 * piece: a dependency-free, deterministic score -> probability mapping fitted on
 * a calibration split.
 *
 * The mapping is a frozen, versioned, digest-bound artifact. Fitting is a pure
 * function over `{score, label}` samples; the same samples and bins produce a
 * bit-identical mapping and digest, so a later reader can detect tampering. The
 * mapping never sees the holdout: the caller decides which samples to pass, and
 * the evaluator only ever fits from the calibration split.
 *
 * Reliability bins use add-one smoothing toward the base rate so an empty or
 * single-observation bin yields the base rate, not a 0/1 certainty, and a
 * monotone pass guarantees a higher score never maps to a lower contradiction
 * probability. Below the locked sample floor the result is INSUFFICIENT: a
 * mapping fitted on noise is not a mapping.
 */

const { ELEVEN_BINS, MIN_OBSERVED_RECORDS } = require('./cognitive-lab-probability-calibration');

const MAPPING_SCHEMA_VERSION = 'huqan-contradiction-calibrator-v1';
const MAPPING_STATUS = Object.freeze({ FITTED: 'FITTED', INSUFFICIENT: 'INSUFFICIENT' });

// The two kinds of "probability" the evaluator keeps apart. A declared
// heuristic confidence is never scored as a forecast; only a calibrated mapping
// output is.
const PROBABILITY_KIND = Object.freeze({
  DECLARED_HEURISTIC: 'DECLARED_HEURISTIC',
  CALIBRATED: 'CALIBRATED',
});

const MAX_MAPPING_BINS = 32;

function requireUnitInterval(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${field} must be a number between 0 and 1`);
  }
  return value;
}

function validateEdges(bins) {
  if (!Array.isArray(bins) || bins.length < 1 || bins.length > MAX_MAPPING_BINS) {
    throw new TypeError(`bins must be 1-${MAX_MAPPING_BINS} strictly increasing edges in (0, 1]`);
  }
  let previous = 0;
  for (const edge of bins) {
    requireUnitInterval(edge, 'bin edge');
    if (edge <= previous) throw new TypeError('bin edges must be strictly increasing');
    previous = edge;
  }
  if (bins[bins.length - 1] !== 1) throw new TypeError('the final bin edge must be 1');
  return Object.freeze([...bins]);
}

function binIndex(edges, score) {
  let index = edges.findIndex((edge) => score < edge);
  if (index === -1) index = edges.length - 1;
  return index;
}

// Fixed key order so the digest is a function of the mapping, not of insertion
// order. `undefined`/`null` never appear: every field is written explicitly.
function canonicalMapping(mapping) {
  return JSON.stringify({
    schemaVersion: mapping.schemaVersion,
    edges: mapping.edges,
    probabilities: mapping.probabilities,
    prior: mapping.prior,
    sampleCount: mapping.sampleCount,
    positives: mapping.positives,
  });
}

function digestOf(mapping) {
  return require('node:crypto').createHash('sha256').update(canonicalMapping(mapping), 'utf8').digest('hex');
}

/**
 * Fit a frozen score -> P(contradiction) mapping over labelled samples.
 *
 * @param {object} input
 * @param {ReadonlyArray<{score:number,label:0|1}>} input.samples labelled rule
 *   scores; label 1 means the human adjudicated CONTRADICTION
 * @param {ReadonlyArray<number>} [input.bins] reliability bin edges, strictly
 *   increasing, ending at 1; defaults to the canonical eleven bins
 * @param {number} [input.minSamples] the locked sample floor; never below the
 *   calibration slice's own minimum, so a caller cannot lower it
 * @returns {Readonly<object>} `{status, probabilityKind, reliable, mapping,
 *   digest, reason}`; `mapping` is null when INSUFFICIENT
 */
function fitScoreMapping({ samples, bins = ELEVEN_BINS, minSamples = MIN_OBSERVED_RECORDS } = {}) {
  if (!Array.isArray(samples)) throw new TypeError('samples must be an array');
  const edges = validateEdges(bins);
  if (!Number.isInteger(minSamples) || minSamples < MIN_OBSERVED_RECORDS) {
    throw new TypeError(`minSamples must be an integer of at least ${MIN_OBSERVED_RECORDS}`);
  }
  const counts = edges.map(() => ({ n: 0, c: 0 }));
  let total = 0;
  let positives = 0;
  for (const sample of samples) {
    if (!sample || typeof sample !== 'object') throw new TypeError('each sample must be an object');
    const score = requireUnitInterval(sample.score, 'sample score');
    if (sample.label !== 0 && sample.label !== 1) throw new TypeError('sample label must be 0 or 1');
    const bucket = counts[binIndex(edges, score)];
    bucket.n += 1;
    bucket.c += sample.label;
    total += 1;
    positives += sample.label;
  }
  const prior = total === 0 ? 0.5 : positives / total;
  // Add-one smoothing toward the base rate: an empty bin is the base rate, and a
  // bin with no positives is not a hard 0. Then a monotone pass so the mapping
  // is non-decreasing in the score.
  const probabilities = counts.map(({ n, c }) => (c + prior) / (n + 1));
  for (let i = 1; i < probabilities.length; i += 1) {
    if (probabilities[i] < probabilities[i - 1]) probabilities[i] = probabilities[i - 1];
  }
  const reliable = total >= minSamples;
  const body = {
    schemaVersion: MAPPING_SCHEMA_VERSION,
    edges,
    probabilities: Object.freeze([...probabilities]),
    prior,
    sampleCount: total,
    positives,
  };
  if (!reliable) {
    return Object.freeze({
      schemaVersion: MAPPING_SCHEMA_VERSION,
      status: MAPPING_STATUS.INSUFFICIENT,
      probabilityKind: PROBABILITY_KIND.CALIBRATED,
      reliable: false,
      minSamples,
      mapping: null,
      digest: null,
      reason: 'sample_below_minimum',
    });
  }
  const digest = digestOf(body);
  const mapping = Object.freeze({ ...body, digest });
  return Object.freeze({
    schemaVersion: MAPPING_SCHEMA_VERSION,
    status: MAPPING_STATUS.FITTED,
    probabilityKind: PROBABILITY_KIND.CALIBRATED,
    reliable: true,
    minSamples,
    mapping,
    digest,
    reason: 'fitted',
  });
}

/**
 * Apply a fitted mapping to a raw rule score. Pure and total: any score in
 * [0, 1] lands in exactly one bin. The mapping shape is validated so a truncated
 * or reordered artifact cannot silently mis-score.
 */
function applyMapping(mapping, score) {
  if (!mapping || typeof mapping !== 'object') throw new TypeError('mapping is required');
  const edges = validateEdges(mapping.edges);
  if (!Array.isArray(mapping.probabilities) || mapping.probabilities.length !== edges.length) {
    throw new TypeError('mapping probabilities must align with the bin edges');
  }
  for (const probability of mapping.probabilities) requireUnitInterval(probability, 'mapping probability');
  const value = requireUnitInterval(score, 'score');
  return mapping.probabilities[binIndex(edges, value)];
}

/** Recompute the digest and compare; a mismatch means the artifact was edited. */
function verifyMappingDigest(mapping) {
  if (!mapping || typeof mapping !== 'object' || typeof mapping.digest !== 'string') return false;
  try {
    return digestOf(mapping) === mapping.digest;
  } catch {
    return false;
  }
}

module.exports = {
  MAPPING_SCHEMA_VERSION,
  MAPPING_STATUS,
  PROBABILITY_KIND,
  MAX_MAPPING_BINS,
  canonicalMapping,
  fitScoreMapping,
  applyMapping,
  verifyMappingDigest,
};
