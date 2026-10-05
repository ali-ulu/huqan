'use strict';

/**
 * Experience — Promotion CI gate (#3463, R08).
 *
 * The procedure registry's `setActiveVersion()` already refuses to activate a
 * version without version-bound qualification evidence (#3460). What it still
 * cannot see is whether a *measured* candidate is actually better than the
 * version it would replace: a candidate whose score merely edges past the
 * incumbent on one noisy sample can be promoted as if the improvement were
 * real. This module is the missing rule: a promotion clears only when the
 * candidate's confidence interval lies strictly above the incumbent's, so a
 * difference inside the measurement noise is never read as an improvement.
 *
 * ## A pure gate over already-calibrated evidence
 *
 * The unit is one comparison: two scores, each `{ mean, n, ci: { lower, upper
 * } }`, where the interval is the confidence interval of the mean produced by
 * the existing calibration surfaces (e.g. `lib/cognitive-lab-paired-delta.js`'s
 * seeded paired bootstrap). This module adds no estimator and rewrites no
 * calibration: it validates the two scores, applies one pre-declared
 * comparison, and returns a verdict. `n` is the observed sample count, and it
 * is load-bearing — `INSUFFICIENT` is not `0` (#3457): too few observations is
 * absence of evidence, never evidence of improvement.
 *
 * ## The comparison, and why it is not a noise-leeway
 *
 * A candidate promotes only when its interval is *disjoint* from the
 * incumbent's and on the better side:
 *
 *   higher-is-better:  candidate.ci.lower  >  active.ci.upper
 *   lower-is-better:   candidate.ci.upper  <  active.ci.lower
 *
 * Strictly greater, never `>=`: an interval that merely touches the
 * incumbent's is still inside the noise and is refused. This deliberately does
 * NOT copy DGM's `original_score - noise_leeway` / `score >= original_score`
 * form (radar #3280, corrected in docs/reports/development-plan-20261001.md):
 * that condition accepts a result *below* the baseline by the leeway, which is
 * the opposite of requiring the candidate to clear it.
 *
 * ## The contract is locked before the scores exist
 *
 * `direction`, `confidenceLevel` and `minSamples` are pre-declared parameters,
 * so a threshold cannot be chosen after seeing the scores. A caller locks them
 * with `lockPromotionContract()` and passes the returned frozen contract to
 * `evaluatePromotionGate()`. A bare object — even a frozen one — is refused:
 * the gate cannot tell a contract declared before measurement from one
 * assembled at scoring time, so it accepts only the object `lockPromotionContract`
 * mints. `confidenceLevel` documents the level the supplied intervals were
 * built at.
 *
 * ## Scores are bound to the versions they describe
 *
 * A score may carry the `version` it was measured for. When the registry
 * supplies `expect` (`{ activeVersion, candidateVersion }`), the gate refuses a
 * score whose `version` does not match, so a stale incumbent's or an unrelated
 * candidate's score cannot be read as clearing the version actually being
 * promoted. A score may also declare its own `direction`; a disagreement with
 * the contract is refused rather than silently compared.
 *
 * ## Authority
 *
 * The gate reads two scores and returns a verdict; it measures nothing, writes
 * nothing and promotes nothing. The registry is the authority that moves the
 * active pointer, and it calls this gate only when a caller supplies the
 * evidence.
 */

const { isPlainObject } = require('../is-plain-object');

const GATE_STATUS = Object.freeze({
  PROMOTE: 'PROMOTE',
  REFUSE: 'REFUSE',
  INSUFFICIENT: 'INSUFFICIENT',
});

const GATE_CODES = Object.freeze({
  CI_NOT_CLEARED: 'promotion_ci_not_cleared',
  INSUFFICIENT: 'promotion_insufficient',
  DIRECTION_MISMATCH: 'promotion_direction_mismatch',
  INVALID_CONTRACT: 'promotion_invalid_contract',
  INVALID_SCORE: 'promotion_invalid_score',
  VERSION_MISMATCH: 'promotion_score_version_mismatch',
});

const DIRECTIONS = Object.freeze({
  HIGHER_IS_BETTER: 'higher-is-better',
  LOWER_IS_BETTER: 'lower-is-better',
});

const CONTRACT_FIELDS = Object.freeze(['direction', 'confidenceLevel', 'minSamples']);

// A non-enumerable brand only `lockPromotionContract()` can mint, so a contract
// assembled at scoring time cannot pass for one declared before measurement.
const LOCKED = Symbol('huqan.promotion.contract.locked');

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isVersionToken(value) {
  return nonEmptyString(value) || isFiniteNumber(value);
}

/**
 * Validate and freeze the pre-declared contract, branding it as locked. Every
 * field is required and no default is invented: a threshold chosen at scoring
 * time is a parameter the promotion rule did not freeze. Unknown fields are
 * refused so a caller cannot smuggle an extra tolerance past the contract.
 */
function lockPromotionContract(contract) {
  if (!isPlainObject(contract)) {
    return { ok: false, code: GATE_CODES.INVALID_CONTRACT, field: 'contract' };
  }
  for (const field of Object.keys(contract)) {
    if (!CONTRACT_FIELDS.includes(field)) {
      return { ok: false, code: GATE_CODES.INVALID_CONTRACT, field };
    }
  }
  for (const field of CONTRACT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(contract, field)) {
      return { ok: false, code: GATE_CODES.INVALID_CONTRACT, field };
    }
  }
  if (contract.direction !== DIRECTIONS.HIGHER_IS_BETTER && contract.direction !== DIRECTIONS.LOWER_IS_BETTER) {
    return { ok: false, code: GATE_CODES.INVALID_CONTRACT, field: 'direction' };
  }
  if (!isFiniteNumber(contract.confidenceLevel) || contract.confidenceLevel <= 0 || contract.confidenceLevel >= 1) {
    return { ok: false, code: GATE_CODES.INVALID_CONTRACT, field: 'confidenceLevel' };
  }
  if (!Number.isInteger(contract.minSamples) || contract.minSamples < 1) {
    return { ok: false, code: GATE_CODES.INVALID_CONTRACT, field: 'minSamples' };
  }
  return {
    ok: true,
    contract: Object.freeze(Object.defineProperty({
      direction: contract.direction,
      confidenceLevel: contract.confidenceLevel,
      minSamples: contract.minSamples,
    }, LOCKED, { value: true, enumerable: false })),
  };
}

/**
 * Validate one score. `mean` and both interval bounds must be finite, `n` a
 * non-negative integer, and the interval well-ordered (`lower <= upper`). An
 * optional `version` names the version the score was measured for, and an
 * optional `direction` must be one of the known directions. A malformed score
 * is refused, never coerced to zero — a broken measurement must not be able to
 * clear a promotion gate.
 */
function validateScore(score, field) {
  if (!isPlainObject(score)) return { ok: false, field };
  if (!isFiniteNumber(score.mean)) return { ok: false, field: `${field}.mean` };
  if (!isNonNegativeInteger(score.n)) return { ok: false, field: `${field}.n` };
  if (!isPlainObject(score.ci)) return { ok: false, field: `${field}.ci` };
  const { lower, upper } = score.ci;
  if (!isFiniteNumber(lower) || !isFiniteNumber(upper) || lower > upper) {
    return { ok: false, field: `${field}.ci` };
  }
  if (score.direction !== undefined && score.direction !== DIRECTIONS.HIGHER_IS_BETTER
    && score.direction !== DIRECTIONS.LOWER_IS_BETTER) {
    return { ok: false, field: `${field}.direction` };
  }
  if (score.version !== undefined && !isVersionToken(score.version)) {
    return { ok: false, field: `${field}.version` };
  }
  return {
    ok: true,
    score: Object.freeze({
      mean: score.mean, n: score.n, ci: Object.freeze({ lower, upper }),
      ...(score.direction === undefined ? {} : { direction: score.direction }),
      ...(score.version === undefined ? {} : { version: score.version }),
    }),
  };
}

/**
 * The signed gap between the two intervals on the better side. Positive means
 * the candidate's interval lies strictly above the incumbent's; `0` means they
 * touch (still inside the noise); negative means they overlap.
 */
function intervalMargin(direction, active, candidate) {
  return direction === DIRECTIONS.HIGHER_IS_BETTER
    ? candidate.ci.lower - active.ci.upper
    : active.ci.lower - candidate.ci.upper;
}

/**
 * Decide whether a measured candidate may replace the active version. Returns
 * `{ ok: true, status, code, ... }`; `ok: false` is reserved for malformed
 * input. `PROMOTE` is the only status a promotion may proceed on — `REFUSE`
 * (measured, interval not disjoint) and `INSUFFICIENT` (too few samples) both
 * leave the active pointer where it is. `contract` must be the frozen object
 * returned by `lockPromotionContract()`; a bare object is refused. When
 * `expect` is supplied, each score's `version` must match the version it is
 * compared against.
 */
function evaluatePromotionGate(evidence) {
  if (!isPlainObject(evidence)) {
    return { ok: false, code: GATE_CODES.INVALID_SCORE, field: 'evidence' };
  }
  const { activeScore, candidateScore, contract, expect } = evidence;
  if (!isPlainObject(contract) || contract[LOCKED] !== true) {
    return { ok: false, code: GATE_CODES.INVALID_CONTRACT, field: 'contract' };
  }
  const locked = lockPromotionContract(contract);
  if (!locked.ok) return locked;
  const { direction, confidenceLevel, minSamples } = locked.contract;

  const active = validateScore(activeScore, 'activeScore');
  if (!active.ok) return { ok: false, code: GATE_CODES.INVALID_SCORE, field: active.field };
  const candidate = validateScore(candidateScore, 'candidateScore');
  if (!candidate.ok) return { ok: false, code: GATE_CODES.INVALID_SCORE, field: candidate.field };

  if (isPlainObject(expect)) {
    if (expect.activeVersion !== undefined && String(active.score.version) !== String(expect.activeVersion)) {
      return { ok: false, code: GATE_CODES.VERSION_MISMATCH, field: 'activeScore.version' };
    }
    if (expect.candidateVersion !== undefined && String(candidate.score.version) !== String(expect.candidateVersion)) {
      return { ok: false, code: GATE_CODES.VERSION_MISMATCH, field: 'candidateScore.version' };
    }
  }

  if ((active.score.direction !== undefined && active.score.direction !== direction)
    || (candidate.score.direction !== undefined && candidate.score.direction !== direction)) {
    return { ok: true, status: GATE_STATUS.REFUSE, code: GATE_CODES.DIRECTION_MISMATCH,
      direction, minSamples, confidenceLevel, active: active.score, candidate: candidate.score, margin: null };
  }

  if (active.score.n < minSamples || candidate.score.n < minSamples) {
    return { ok: true, status: GATE_STATUS.INSUFFICIENT, code: GATE_CODES.INSUFFICIENT,
      direction, minSamples, confidenceLevel, active: active.score, candidate: candidate.score, margin: null };
  }

  const margin = intervalMargin(direction, active.score, candidate.score);
  const cleared = margin > 0;
  return {
    ok: true,
    status: cleared ? GATE_STATUS.PROMOTE : GATE_STATUS.REFUSE,
    code: cleared ? null : GATE_CODES.CI_NOT_CLEARED,
    direction, minSamples, confidenceLevel,
    active: active.score, candidate: candidate.score, margin,
  };
}

/**
 * Registry-facing helper: decide whether a pointer move may proceed. A missing
 * evidence object, a first activation (no incumbent) and re-activating the
 * already-active version are not promotions, so the move proceeds without a
 * comparison; otherwise the gate must return `PROMOTE`. Returns `{ ok: true }`
 * when the move may proceed, or `{ ok: false, code, promotion }` when it must
 * fail closed.
 */
function guardPromotionMove({ promotionEvidence, currentVersion, candidateVersion } = {}) {
  if (promotionEvidence === undefined) return { ok: true };
  if (currentVersion === undefined || String(currentVersion) === String(candidateVersion)) return { ok: true };
  const gate = evaluatePromotionGate({
    ...promotionEvidence,
    expect: { activeVersion: currentVersion, candidateVersion },
  });
  if (!gate.ok || gate.status !== GATE_STATUS.PROMOTE) {
    return { ok: false, code: gate.code, promotion: gate };
  }
  return { ok: true, promotion: gate };
}

module.exports = {
  GATE_STATUS,
  GATE_CODES,
  DIRECTIONS,
  lockPromotionContract,
  evaluatePromotionGate,
  guardPromotionMove,
};
