'use strict';

/**
 * R50 PR2 — deterministic rule-score to contradiction-probability calibrator
 * (issue #3582, roadmap key R50).
 *
 * Arm A reads the detectors' declared heuristic confidence (`0.90/0.95`) as if
 * it were an outcome probability. It is not: it was authored, never measured
 * against outcomes. Arm B keeps the same detector coverage and the same raw
 * rule score, but maps that score to P(contradiction) with a mapping fit only on
 * the calibration split. This module owns that mapping.
 *
 * The fit is deterministic and dependency-free:
 *
 *   - records are grouped by their exact raw score;
 *   - the per-group rate is made non-decreasing with the pool-adjacent-violators
 *     algorithm (isotonic regression), so a lower score can never claim a higher
 *     contradiction probability than a higher score;
 *   - the pooled counts are Laplace-smoothed so a small calibration split cannot
 *     produce a hard 0 or 1;
 *   - the artifact is canonicalized and digested, so the same records always
 *     yield the same bytes.
 *
 * `fitCalibration` refuses any record whose `split` is not `calibration`: a fit
 * that can read the holdout is the leakage the preregistration forbids, so the
 * guard is in the fitter rather than in a caller's discipline. `applyCalibration`
 * verifies the artifact digest before it reads a point, so a tampered mapping is
 * rejected instead of silently scoring.
 *
 * Nothing here is a model, a probability statement about the world, or an
 * authority change: the output is a frozen, candidate-only score-to-probability
 * artifact.
 */

const { isPlainObject } = require('./is-plain-object');
const { stableStringify, sha256Hex } = require('./hash-chain');

const CALIBRATOR_SCHEMA_VERSION = 'huqan-contradiction-calibrator-v1';
const CALIBRATOR_KIND = 'score-to-probability-v1';

const CALIBRATOR_STATUS = Object.freeze({
  MEASURED: 'MEASURED',
  INSUFFICIENT: 'INSUFFICIENT',
});

// A probability fit under ten observations is noise, not a mapping. This floor
// matches the Cognitive Lab calibration minimum (MIN_OBSERVED_RECORDS = 10).
const MIN_CALIBRATION_SAMPLES = 10;

const SCORABLE_LABELS = Object.freeze(['CONTRADICTION', 'NOT_CONTRADICTION']);

const CALIBRATOR_ERROR_CODES = Object.freeze({
  MISSING_FIELD: 'calibrator_missing_field',
  UNKNOWN_FIELD: 'calibrator_unknown_field',
  INVALID_FIELD: 'calibrator_invalid_field',
  NON_FINITE_SCORE: 'calibrator_non_finite_score',
  UNKNOWN_LABEL: 'calibrator_unknown_label',
  DUPLICATE_DECISION: 'calibrator_duplicate_decision',
  FIT_SPLIT_NOT_CALIBRATION: 'calibrator_fit_split_not_calibration',
  NON_MONOTONIC: 'calibrator_non_monotonic',
  DIGEST_MISMATCH: 'calibrator_digest_mismatch',
});

class ContradictionCalibratorError extends Error {
  constructor(code, path, message) {
    super(message);
    this.name = 'ContradictionCalibratorError';
    this.code = code;
    this.path = path;
  }
}

function fail(code, path, message) {
  throw new ContradictionCalibratorError(code, path, message);
}

/**
 * The contract is locked before the fit: an unknown field is rejected so a
 * threshold cannot be smuggled past it, and every field is required so no
 * parameter is chosen after the calibration split is read.
 */
const CONTRACT_SPEC = Object.freeze({
  minimumSamples: { kind: 'integerAtLeast', min: MIN_CALIBRATION_SAMPLES },
  smoothingAlpha: { kind: 'unitOpenInterval' },
});

function checkContractField(spec, value, path) {
  switch (spec.kind) {
    case 'integerAtLeast':
      if (!Number.isInteger(value) || value < spec.min) {
        fail(CALIBRATOR_ERROR_CODES.INVALID_FIELD, path, `${path} must be an integer of at least ${spec.min}`);
      }
      return value;
    case 'unitOpenInterval':
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 1) {
        if (typeof value === 'number' && !Number.isFinite(value)) {
          fail(CALIBRATOR_ERROR_CODES.NON_FINITE_SCORE, path, `${path} must be finite`);
        }
        fail(CALIBRATOR_ERROR_CODES.INVALID_FIELD, path, `${path} must be a number strictly between 0 and 1`);
      }
      return value;
    default:
      fail(CALIBRATOR_ERROR_CODES.INVALID_FIELD, path, `${path} has an unknown contract kind`);
  }
  return value;
}

function lockFitContract(contract) {
  if (!isPlainObject(contract)) fail(CALIBRATOR_ERROR_CODES.MISSING_FIELD, 'contract', 'contract is required');
  const locked = {};
  for (const [field, spec] of Object.entries(CONTRACT_SPEC)) {
    if (!Object.prototype.hasOwnProperty.call(contract, field)) {
      fail(CALIBRATOR_ERROR_CODES.MISSING_FIELD, field, `contract.${field} is required`);
    }
    locked[field] = checkContractField(spec, contract[field], field);
  }
  for (const field of Object.keys(contract)) {
    if (!Object.prototype.hasOwnProperty.call(CONTRACT_SPEC, field)) {
      fail(CALIBRATOR_ERROR_CODES.UNKNOWN_FIELD, field, `contract.${field} is not part of the contract`);
    }
  }
  return Object.freeze(locked);
}

function requireFiniteScore(score, path) {
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    fail(CALIBRATOR_ERROR_CODES.NON_FINITE_SCORE, path, `${path} must be a finite number`);
  }
  return score;
}

/**
 * Pool adjacent violators. `groups` is ascending by score with `{ score, n, pos }`.
 * The result is the non-decreasing isotonic fit of the group rates, each group
 * carrying the pooled counts of the block it landed in.
 */
function poolAdjacentViolators(groups) {
  const stack = [];
  for (const group of groups) {
    let block = { n: group.n, pos: group.pos, first: group.score, last: group.score };
    while (stack.length > 0) {
      const previous = stack[stack.length - 1];
      const previousRate = previous.pos / previous.n;
      const blockRate = block.pos / block.n;
      if (previousRate <= blockRate) break;
      stack.pop();
      block = { n: previous.n + block.n, pos: previous.pos + block.pos, first: previous.first, last: block.last };
    }
    stack.push(block);
  }
  const rateByScore = new Map();
  for (const block of stack) {
    const rate = (block.pos + 0) / block.n;
    for (const group of groups) {
      if (group.score >= block.first && group.score <= block.last) rateByScore.set(group.score, { rate, n: block.n, pos: block.pos });
    }
  }
  return rateByScore;
}

/**
 * Fit a frozen score -> P(contradiction) mapping on the calibration split only.
 *
 * @param {object} input
 * @param {ReadonlyArray<{decisionId:string, split:string, score:number, label:string}>} input.records
 * @param {object} input.contract `{ minimumSamples, smoothingAlpha }`
 * @returns {Readonly<object>} a `MEASURED` artifact, or an `INSUFFICIENT` report
 *   with `artifact: null` when the scorable calibration support is below the
 *   locked minimum. A `holdout` or `train` record is rejected outright.
 */
function fitCalibration({ records, contract } = {}) {
  const locked = lockFitContract(contract);
  if (!Array.isArray(records)) fail(CALIBRATOR_ERROR_CODES.INVALID_FIELD, 'records', 'records must be an array');

  const seen = new Set();
  const groups = new Map();
  let scorable = 0;
  let excluded = 0;
  for (const [index, record] of records.entries()) {
    const at = `records[${index}]`;
    if (!isPlainObject(record)) fail(CALIBRATOR_ERROR_CODES.INVALID_FIELD, at, `${at} must be an object`);
    const { decisionId, split, score, label } = record;
    if (typeof decisionId !== 'string' || !decisionId.trim()) {
      fail(CALIBRATOR_ERROR_CODES.INVALID_FIELD, `${at}.decisionId`, 'decisionId is required');
    }
    if (seen.has(decisionId)) {
      fail(CALIBRATOR_ERROR_CODES.DUPLICATE_DECISION, `${at}.decisionId`, `duplicate decision ${decisionId}`);
    }
    seen.add(decisionId);
    // Leakage guard: the fitter reads the calibration split and nothing else.
    if (split !== 'calibration') {
      fail(CALIBRATOR_ERROR_CODES.FIT_SPLIT_NOT_CALIBRATION, `${at}.split`,
        `fit input must be the calibration split; received ${String(split)}`);
    }
    if (!SCORABLE_LABELS.includes(label)) {
      if (typeof label !== 'string') fail(CALIBRATOR_ERROR_CODES.UNKNOWN_LABEL, `${at}.label`, 'label is required');
      // UNCERTAIN / INVALID_PAIR are not binary failures; they are excluded.
      excluded += 1;
      continue;
    }
    requireFiniteScore(score, `${at}.score`);
    const y = label === 'CONTRADICTION' ? 1 : 0;
    const group = groups.get(score) || { score, n: 0, pos: 0 };
    group.n += 1;
    group.pos += y;
    groups.set(score, group);
    scorable += 1;
  }

  const measurement = Object.freeze({ scorable, excluded, distinctScores: groups.size });
  if (scorable < locked.minimumSamples) {
    return Object.freeze({
      schemaVersion: CALIBRATOR_SCHEMA_VERSION,
      status: CALIBRATOR_STATUS.INSUFFICIENT,
      kind: CALIBRATOR_KIND,
      contract: locked,
      measurement,
      artifact: null,
      reason: 'sample_below_minimum',
    });
  }

  const ordered = [...groups.values()].sort((left, right) => left.score - right.score);
  const isotonic = poolAdjacentViolators(ordered);
  const points = [];
  let previousProbability = -Infinity;
  for (const group of ordered) {
    const block = isotonic.get(group.score);
    const smoothed = (block.pos + locked.smoothingAlpha) / (block.n + 2 * locked.smoothingAlpha);
    // PAV guarantees a non-decreasing rate; smoothing with a block-varying count
    // can still tie-break downward by an epsilon, so clamp to keep the mapping
    // monotone as the contract requires.
    const probability = Math.max(smoothed, previousProbability);
    previousProbability = probability;
    points.push(Object.freeze({ score: group.score, probability, support: group.n, positives: group.pos }));
  }
  for (let i = 1; i < points.length; i += 1) {
    if (points[i].probability < points[i - 1].probability) {
      fail(CALIBRATOR_ERROR_CODES.NON_MONOTONIC, `points[${i}]`, 'calibrated probabilities must be non-decreasing in score');
    }
  }

  const body = {
    schemaVersion: CALIBRATOR_SCHEMA_VERSION,
    kind: CALIBRATOR_KIND,
    contract: locked,
    measurement,
    points,
  };
  const artifact = Object.freeze({ ...body, digest: sha256Hex(stableStringify(body)) });
  return Object.freeze({
    schemaVersion: CALIBRATOR_SCHEMA_VERSION,
    status: CALIBRATOR_STATUS.MEASURED,
    kind: CALIBRATOR_KIND,
    contract: locked,
    measurement,
    artifact,
    reason: 'measured',
  });
}

/** Recompute the canonical digest of a calibration artifact body. */
function computeCalibrationDigest(artifact) {
  const { digest, ...body } = artifact;
  return sha256Hex(stableStringify(body));
}

function assertArtifact(artifact) {
  if (!isPlainObject(artifact)) fail(CALIBRATOR_ERROR_CODES.INVALID_FIELD, 'artifact', 'artifact is required');
  if (artifact.schemaVersion !== CALIBRATOR_SCHEMA_VERSION || artifact.kind !== CALIBRATOR_KIND) {
    fail(CALIBRATOR_ERROR_CODES.INVALID_FIELD, 'artifact.schemaVersion', 'unknown calibration artifact schema');
  }
  if (typeof artifact.digest !== 'string' || computeCalibrationDigest(artifact) !== artifact.digest) {
    fail(CALIBRATOR_ERROR_CODES.DIGEST_MISMATCH, 'artifact.digest', 'calibration artifact digest does not match its content');
  }
  if (!Array.isArray(artifact.points) || artifact.points.length === 0) {
    fail(CALIBRATOR_ERROR_CODES.INVALID_FIELD, 'artifact.points', 'calibration artifact needs at least one point');
  }
  let previous = -Infinity;
  for (const [index, point] of artifact.points.entries()) {
    if (!isPlainObject(point)) fail(CALIBRATOR_ERROR_CODES.INVALID_FIELD, `artifact.points[${index}]`, 'point must be an object');
    requireFiniteScore(point.score, `artifact.points[${index}].score`);
    if (typeof point.probability !== 'number' || !Number.isFinite(point.probability)
      || point.probability < 0 || point.probability > 1) {
      fail(CALIBRATOR_ERROR_CODES.INVALID_FIELD, `artifact.points[${index}].probability`, 'probability must be in [0, 1]');
    }
    if (point.probability < previous) {
      fail(CALIBRATOR_ERROR_CODES.NON_MONOTONIC, `artifact.points[${index}]`, 'probabilities must be non-decreasing');
    }
    previous = point.probability;
  }
  return artifact;
}

/**
 * Map a raw score to its frozen probability. Below the first point and above the
 * last the nearest point's probability is used; between points the value is
 * linearly interpolated, so a continuous fusion score (PR3) and a discrete rule
 * score (PR2) share one deterministic readout.
 */
function applyCalibration(artifact, score) {
  assertArtifact(artifact);
  requireFiniteScore(score, 'score');
  const points = artifact.points;
  if (score <= points[0].score) return points[0].probability;
  const last = points[points.length - 1];
  if (score >= last.score) return last.probability;
  for (let i = 1; i < points.length; i += 1) {
    const left = points[i - 1];
    const right = points[i];
    if (score <= right.score) {
      const span = right.score - left.score;
      if (span === 0) return right.probability;
      const ratio = (score - left.score) / span;
      return left.probability + ratio * (right.probability - left.probability);
    }
  }
  return last.probability;
}

module.exports = {
  CALIBRATOR_SCHEMA_VERSION,
  CALIBRATOR_KIND,
  CALIBRATOR_STATUS,
  CALIBRATOR_ERROR_CODES,
  MIN_CALIBRATION_SAMPLES,
  SCORABLE_LABELS,
  ContradictionCalibratorError,
  lockFitContract,
  fitCalibration,
  computeCalibrationDigest,
  applyCalibration,
};
