'use strict';

/**
 * Experience — Staged promotion gate (#3466, R11).
 *
 * #3463's promotion gate answers one question: given two *measured* scores, is
 * the candidate's confidence interval strictly above the incumbent's? It
 * deliberately reads scores that already exist and measures nothing. This
 * module answers the question that comes first: may a promotion even be
 * *considered*? A compiled procedure is not eligible until it has run a
 * bounded staged trial and that trial has passed — an unrun or under-sampled
 * hypothesis must not reach the registry at all.
 *
 * ## Two gates, in order, both fail-closed
 *
 * `evaluateStagedPromotion()` composes the two existing surfaces without
 * adding a third:
 *
 *   1. `./canary.js`'s `evaluateCanaryTrial()` runs the bounded staged trial
 *      over the candidate and baseline runs. Only `passed` advances. `in_trial`
 *      (not enough evidence yet), `failed` (including "cap reached without
 *      enough evidence" — fail-closed) and a shape-refused comparison all stop
 *      here, so an unmeasured hypothesis is never promoted.
 *   2. Only after the trial passes does `./promotion-ci-gate.js`'s
 *      `evaluatePromotionGate()` compare the candidate's interval against the
 *      incumbent's. A difference inside the measurement noise is refused there.
 *
 * A staged trial that passes is necessary but not sufficient: the CI gate still
 * has to clear. Neither gate is reimplemented here — this module is the wiring,
 * not a new estimator.
 *
 * ## The noise-leeway is not reintroduced
 *
 * #3466 names a "noise-leeway correction". The correction is already in the
 * code and is reused, not rewritten: `./promotion-ci-gate.js` deliberately does
 * NOT copy DGM's `original_score - noise_leeway` / `score >= original_score`
 * form (radar #3280, corrected in docs/reports/development-plan-20261001.md),
 * which accepts a result *below* the baseline. The staged gate inherits that
 * strict interval comparison through the CI gate rather than restating it.
 *
 * ## Authority
 *
 * This module reads a trial and two scores and returns a verdict plus, when it
 * passes, the `promotionEvidence` a caller may hand to the registry's
 * `setActiveVersion()`. It writes nothing and promotes nothing; the registry
 * remains the only authority that moves the active pointer.
 */

const { evaluateCanaryTrial, CANARY_STATUS } = require('./canary');
const { evaluatePromotionGate, GATE_STATUS, GATE_CODES } = require('./promotion-ci-gate');
const { isPlainObject } = require('../is-plain-object');

const STAGED_CODES = Object.freeze({
  // The staged trial has not passed: unmeasured, under-sampled, failed, or
  // refused for shape. Never a promotion.
  STAGED_NOT_PASSED: 'promotion_staged_not_passed',
  // The trial was passed but the CI gate still did not clear.
  CI_NOT_CLEARED: GATE_CODES.CI_NOT_CLEARED,
  INSUFFICIENT: GATE_CODES.INSUFFICIENT,
  INVALID_TRIAL: 'promotion_staged_invalid_trial',
  INVALID_EVIDENCE: 'promotion_staged_invalid_evidence',
});

/**
 * Run the staged trial and, only if it passed, the CI comparison.
 *
 * `trial` is the exact input object `evaluateCanaryTrial()` accepts
 * (`candidateRuns`, `baselineWindowRuns`, and the optional bounds). `contract`
 * is the frozen object `lockPromotionContract()` minted. Returns
 * `{ ok: true, status, code, staged, promotion }`; `ok: false` is reserved for
 * malformed input. `PROMOTE` is the only status a promotion may proceed on.
 */
function evaluateStagedPromotion({ trial, activeScore, candidateScore, contract, expect } = {}) {
  if (!isPlainObject(trial)) {
    return { ok: false, code: STAGED_CODES.INVALID_TRIAL, field: 'trial' };
  }
  const staged = evaluateCanaryTrial(trial);
  if (!staged.ok) {
    return { ok: true, status: GATE_STATUS.REFUSE, code: STAGED_CODES.STAGED_NOT_PASSED, staged, promotion: null };
  }
  if (staged.status !== CANARY_STATUS.PASSED) {
    // `in_trial` is absence of evidence; `failed` (including a cap reached
    // without enough evidence) is a refusal. Both leave the pointer alone.
    const status = staged.status === CANARY_STATUS.IN_TRIAL ? GATE_STATUS.INSUFFICIENT : GATE_STATUS.REFUSE;
    return { ok: true, status, code: STAGED_CODES.STAGED_NOT_PASSED, staged, promotion: null };
  }
  const promotion = evaluatePromotionGate({ activeScore, candidateScore, contract, expect });
  if (!promotion.ok) {
    return { ok: false, code: STAGED_CODES.INVALID_EVIDENCE, field: promotion.field, staged, promotion };
  }
  return { ...promotion, staged };
}

/**
 * Derive the `promotionEvidence` a caller hands to `setActiveVersion()` — but
 * only from a trial that actually passed. Returns `{ ok: true,
 * promotionEvidence, staged }` or `{ ok: false, code }`. This is the
 * fail-closed hand-off: an `in_trial` or `failed` trial yields no evidence
 * object at all, so a caller cannot accidentally promote an unmeasured
 * hypothesis by forwarding an un-gated score.
 */
function stagedPromotionEvidence({ trial, activeScore, candidateScore, contract, expect } = {}) {
  const verdict = evaluateStagedPromotion({ trial, activeScore, candidateScore, contract, expect });
  if (!verdict.ok) return { ok: false, code: verdict.code, field: verdict.field };
  if (verdict.status !== GATE_STATUS.PROMOTE) {
    return { ok: false, code: verdict.code, status: verdict.status, staged: verdict.staged };
  }
  return {
    ok: true,
    promotionEvidence: { activeScore, candidateScore, contract, expect },
    staged: verdict.staged,
  };
}

/**
 * Registry-facing helper for an optional `stagedEvidence` argument. When the
 * caller supplies staged evidence and no pre-derived `promotionEvidence`, it is
 * converted here so the registry enforces the staged gate itself; supplying
 * both is a caller error (the two could disagree) and is refused. Absent staged
 * evidence passes the given `promotionEvidence` through unchanged, so the
 * pre-#3466 behaviour is preserved.
 */
function guardStagedPromotion({ stagedEvidence, promotionEvidence } = {}) {
  if (stagedEvidence === undefined) return { ok: true, promotionEvidence };
  if (promotionEvidence !== undefined) {
    return { ok: false, code: STAGED_CODES.INVALID_EVIDENCE, field: 'promotionEvidence' };
  }
  const derived = stagedPromotionEvidence(stagedEvidence);
  if (!derived.ok) return { ok: false, code: derived.code, field: derived.field };
  return { ok: true, promotionEvidence: derived.promotionEvidence };
}

module.exports = {
  STAGED_CODES,
  evaluateStagedPromotion,
  stagedPromotionEvidence,
  guardStagedPromotion,
};
