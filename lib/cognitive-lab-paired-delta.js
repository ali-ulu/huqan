'use strict';

/**
 * Cognitive Lab paired baseline/candidate calibration delta (#3414, slice 3308-P2).
 *
 * #3308's `calibrate` scores one set of explicit pre-outcome probabilities: it
 * reports Brier, reliability bins and ECE for a single arm. That is not yet a
 * gain measurement, which is why it returns `assertsGain: false`. A gain is a
 * *paired* claim: the same decisions, the same outcomes, one arm at a time, and
 * a pre-declared rule for when the difference is real.
 *
 * This module is that rule. It takes the same calibration records the existing
 * reader produces for two arms, pairs them by decision id, and reports the
 * paired Brier delta (baseline minus candidate, so positive means the candidate
 * is better) with a seeded paired-bootstrap interval and an ECE
 * non-inferiority check. Everything that could be chosen after seeing the data
 * is locked in a contract validated before a single delta is computed: the
 * bootstrap method, seed, resample count and confidence level, the meaningful
 * effect, the non-inferiority margin and the minimum paired sample. An unknown
 * method or a contract with a field missing is rejected rather than defaulted;
 * the two arms must cover exactly the same observed decisions or the pairing
 * itself is rejected; too few pairs is INSUFFICIENT, never a number.
 *
 * `assertsGain` is therefore no longer a constant: it is true only when the
 * lower bootstrap bound clears the locked meaningful effect *and* the candidate
 * ECE is non-inferior and the supplied budget verifies equal usage. A
 * higher-but-worse candidate cannot pass, the interval
 * has to clear the threshold rather than the point estimate, and a gain that is
 * real but unmeasured stays NOT_MEASURED. Missing or unverified budget evidence
 * blocks the gain claim while leaving the calibration measurement available.
 *
 * Scope: a pure module plus its tests. It reads no store, opens no cycle (it
 * depends only on the calibration module and is-plain-object, both Core) and
 * adds no runtime surface.
 */

const { isPlainObject } = require('./is-plain-object');
const { budgetUsageCheck } = require('./cognitive-lab-budget-envelope');
const {
  calibrate, ELEVEN_BINS, MIN_OBSERVED_RECORDS,
} = require('./cognitive-lab-probability-calibration');

const PAIRED_DELTA_SCHEMA_VERSION = 'huqan-cognitive-lab-paired-delta-v1';

const PAIRED_STATUS = Object.freeze({
  MEASURED: 'MEASURED',
  INSUFFICIENT: 'INSUFFICIENT',
  REJECT: 'REJECT',
});

const PAIRED_ERROR_CODES = Object.freeze({
  MISSING_FIELD: 'paired_missing_field',
  UNKNOWN_FIELD: 'paired_unknown_field',
  INVALID_FIELD: 'paired_invalid_field',
  UNSUPPORTED_METHOD: 'paired_unsupported_method',
  NON_FINITE_NUMBER: 'paired_non_finite_number',
  UNPAIRED_DECISIONS: 'paired_unpaired_decisions',
});

const DIRECTION = 'lower-brier-is-better';
const BOOTSTRAP_METHOD = 'seeded-paired-bootstrap';

/**
 * A typed contract failure. `code` is a PAIRED_ERROR_CODES value and `path` is
 * the dotted location of the offending field, mirroring the manifest error so a
 * caller reacts to the failure instead of parsing a message.
 */
class PairedDeltaError extends Error {
  constructor(code, path, message) {
    super(message);
    this.name = 'PairedDeltaError';
    this.code = code;
    this.path = path;
  }
}

const CONTRACT_SPEC = Object.freeze({
  method: { kind: 'literal', value: BOOTSTRAP_METHOD },
  seed: { kind: 'nonNegativeInteger' },
  resamples: { kind: 'integerAtLeast', min: 100 },
  confidenceLevel: { kind: 'unitOpenInterval' },
  meaningfulEffect: { kind: 'nonNegativeNumber' },
  nonInferiorityMargin: { kind: 'nonNegativeNumber' },
  minimumSamples: { kind: 'integerAtLeast', min: MIN_OBSERVED_RECORDS },
  direction: { kind: 'literal', value: DIRECTION },
});

function fail(code, path, message) {
  throw new PairedDeltaError(code, path, message);
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function checkContractField(spec, value, path) {
  switch (spec.kind) {
    case 'literal':
      if (value !== spec.value) {
        fail(spec.value === BOOTSTRAP_METHOD ? PAIRED_ERROR_CODES.UNSUPPORTED_METHOD : PAIRED_ERROR_CODES.INVALID_FIELD,
          path, `${path} must be ${spec.value}`);
      }
      return value;
    case 'nonNegativeInteger':
      if (!isNonNegativeInteger(value)) fail(PAIRED_ERROR_CODES.INVALID_FIELD, path, `${path} must be a non-negative integer`);
      return value;
    case 'integerAtLeast':
      if (!Number.isInteger(value) || value < spec.min) {
        fail(PAIRED_ERROR_CODES.INVALID_FIELD, path, `${path} must be an integer of at least ${spec.min}`);
      }
      return value;
    case 'nonNegativeNumber':
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        if (typeof value === 'number' && !Number.isFinite(value)) fail(PAIRED_ERROR_CODES.NON_FINITE_NUMBER, path, `${path} must be finite`);
        fail(PAIRED_ERROR_CODES.INVALID_FIELD, path, `${path} must be a finite number >= 0`);
      }
      return value;
    case 'unitOpenInterval':
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 1) {
        if (typeof value === 'number' && !Number.isFinite(value)) fail(PAIRED_ERROR_CODES.NON_FINITE_NUMBER, path, `${path} must be finite`);
        fail(PAIRED_ERROR_CODES.INVALID_FIELD, path, `${path} must be a number strictly between 0 and 1`);
      }
      return value;
    default:
      fail(PAIRED_ERROR_CODES.INVALID_FIELD, path, `${path} has an unknown contract kind`);
  }
  return value;
}

/**
 * Validate and freeze a paired-delta contract. Every field is required: there is
 * no default, because a default chosen at scoring time is a parameter the
 * experiment did not freeze. Unknown fields are rejected so a caller cannot
 * smuggle a threshold past the contract.
 */
function lockContract(contract) {
  if (!isPlainObject(contract)) fail(PAIRED_ERROR_CODES.MISSING_FIELD, 'contract', 'contract is required');
  const locked = {};
  for (const [field, spec] of Object.entries(CONTRACT_SPEC)) {
    if (!Object.prototype.hasOwnProperty.call(contract, field)) {
      fail(PAIRED_ERROR_CODES.MISSING_FIELD, field, `contract.${field} is required`);
    }
    locked[field] = checkContractField(spec, contract[field], field);
  }
  for (const field of Object.keys(contract)) {
    if (!Object.prototype.hasOwnProperty.call(CONTRACT_SPEC, field)) {
      fail(PAIRED_ERROR_CODES.UNKNOWN_FIELD, field, `contract.${field} is not part of the contract`);
    }
  }
  return Object.freeze(locked);
}

// mulberry32: a tiny deterministic PRNG so the same seed reproduces the same
// resamples byte for byte. Math.random would make the interval unreproducible.
function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(fraction * sorted.length)));
  return sorted[index];
}

function isScorable(record) {
  return record && (record.y === 0 || record.y === 1)
    && typeof record.probability === 'number' && Number.isFinite(record.probability)
    && record.probability >= 0 && record.probability <= 1;
}

function observedBrierMap(records, arm) {
  if (!Array.isArray(records)) fail(PAIRED_ERROR_CODES.INVALID_FIELD, arm, `${arm} records must be an array`);
  const map = new Map();
  const seen = new Set();
  for (const record of records) {
    if (!record || typeof record.decisionId !== 'string' || !record.decisionId) {
      fail(PAIRED_ERROR_CODES.INVALID_FIELD, arm, `${arm} record is missing a decisionId`);
    }
    // Match calibrate(): the first record owns a decisionId even when it is
    // unscorable. A later duplicate must not replace or rescue that decision,
    // otherwise paired Brier and arm-level calibration would score different
    // records for the same id.
    if (seen.has(record.decisionId)) continue;
    seen.add(record.decisionId);
    // Only a classified `observed` record with a scorable outcome pairs. A
    // censored/missing/measurement_error decision is not silently treated as a
    // pair worth zero; it is left out, and the arms then disagree on the key
    // set and the pairing is rejected.
    if (record.status !== 'observed' || !isScorable(record)) continue;
    map.set(record.decisionId, (record.probability - record.y) ** 2);
  }
  return map;
}

function sameKeySet(a, b) {
  if (a.size !== b.size) return false;
  for (const key of a.keys()) if (!b.has(key)) return false;
  return true;
}

function bootstrapInterval(deltas, contract) {
  const random = mulberry32(contract.seed);
  const means = [];
  const n = deltas.length;
  for (let i = 0; i < contract.resamples; i += 1) {
    let sum = 0;
    for (let j = 0; j < n; j += 1) sum += deltas[Math.floor(random() * n)];
    means.push(sum / n);
  }
  means.sort((x, y) => x - y);
  const alpha = 1 - contract.confidenceLevel;
  return Object.freeze({
    lower: percentile(means, alpha / 2),
    upper: percentile(means, 1 - alpha / 2),
  });
}

function insufficient(measurement, contract, reason, budget = null) {
  return Object.freeze({
    schemaVersion: PAIRED_DELTA_SCHEMA_VERSION,
    status: PAIRED_STATUS.INSUFFICIENT,
    direction: DIRECTION,
    contract,
    budget,
    measurement,
    baseline: null,
    candidate: null,
    delta: null,
    gain: false,
    assertsGain: false,
    reason,
  });
}

/**
 * Paired calibration delta over two arms of the same decisions. `baseline` and
 * `candidate` are arrays of calibration records ({decisionId, probability, y})
 * as read back for one measurement. The contract is locked first; a pairing
 * mismatch is REJECT; a pair count below the locked minimum is INSUFFICIENT.
 */
function pairedCalibrationDelta({ baseline, candidate, contract, budget } = {}) {
  const locked = lockContract(contract);
  const budgetCheck = budget === null || budget === undefined
    ? null
    : budgetUsageCheck({
      envelope: budget.envelope,
      baseline: budget.baselineUsage,
      candidate: budget.candidateUsage,
    });
  const baselineBrier = observedBrierMap(baseline, 'baseline');
  const candidateBrier = observedBrierMap(candidate, 'candidate');
  const measurement = Object.freeze({
    baselineObserved: baselineBrier.size,
    candidateObserved: candidateBrier.size,
    paired: 0,
  });
  // Pairing means one outcome per decision in both arms. A decision scored in
  // only one arm cannot be paired, and pretending it can would let a smaller
  // candidate set look better by omission.
  if (!sameKeySet(baselineBrier, candidateBrier)) {
    return Object.freeze({
      schemaVersion: PAIRED_DELTA_SCHEMA_VERSION,
      status: PAIRED_STATUS.REJECT,
      direction: DIRECTION,
      contract: locked,
      budget: budgetCheck,
      measurement,
      baseline: null,
      candidate: null,
      delta: null,
      gain: false,
      assertsGain: false,
      reason: 'unpaired_decisions',
    });
  }
  const ids = [...baselineBrier.keys()].sort();
  const deltas = ids.map((id) => baselineBrier.get(id) - candidateBrier.get(id));
  const paired = Object.freeze({ ...measurement, paired: deltas.length });
  if (deltas.length < locked.minimumSamples) {
    return insufficient(paired, locked, 'sample_below_minimum', budgetCheck);
  }

  const baselineCalibration = calibrate(baseline, { minObserved: locked.minimumSamples });
  const candidateCalibration = calibrate(candidate, { minObserved: locked.minimumSamples });

  const meanDelta = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
  const interval = bootstrapInterval(deltas, locked);
  const eceDelta = (candidateCalibration.ece === null || baselineCalibration.ece === null)
    ? null : candidateCalibration.ece - baselineCalibration.ece;
  const nonInferior = eceDelta !== null && eceDelta <= locked.nonInferiorityMargin;
  const clearsEffect = interval.lower > locked.meaningfulEffect;
  // A missing, overrun or mismatched budget cannot be a gain when the interval
  // clears the effect: an unverified equal-budget claim is not a comparable one.
  const budgetOk = budgetCheck !== null && budgetCheck.assertsEqualBudget;
  const gain = clearsEffect && nonInferior && budgetOk;

  return Object.freeze({
    schemaVersion: PAIRED_DELTA_SCHEMA_VERSION,
    status: PAIRED_STATUS.MEASURED,
    direction: DIRECTION,
    contract: locked,
    budget: budgetCheck,
    measurement: paired,
    baseline: Object.freeze({ brier: baselineCalibration.brier, ece: baselineCalibration.ece }),
    candidate: Object.freeze({ brier: candidateCalibration.brier, ece: candidateCalibration.ece }),
    delta: Object.freeze({
      brier: Object.freeze({
        mean: meanDelta,
        lower: interval.lower,
        upper: interval.upper,
        confidenceLevel: locked.confidenceLevel,
      }),
      ece: Object.freeze({ value: eceDelta, margin: locked.nonInferiorityMargin, nonInferior }),
    }),
    meaningfulEffect: locked.meaningfulEffect,
    gain,
    assertsGain: gain,
    reason: gain ? 'paired_gain_measured'
      : (!clearsEffect ? 'interval_below_meaningful_effect'
        : (!nonInferior ? 'non_inferiority_violated' : 'budget_not_verified')),
  });
}

module.exports = {
  PAIRED_DELTA_SCHEMA_VERSION,
  PAIRED_STATUS,
  PAIRED_ERROR_CODES,
  DIRECTION,
  BOOTSTRAP_METHOD,
  ELEVEN_BINS,
  PairedDeltaError,
  lockContract,
  pairedCalibrationDelta,
  createPairedSampler: mulberry32,
  pairedPercentile: percentile,
};
