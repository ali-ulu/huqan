'use strict';

/**
 * Bounded reask with a deterministic fix (#3500, R45).
 *
 * `lib/experience/repair.js` plans a *reask*: the same step is reproduced with
 * a fresh identity and waits for a fresh approval. This module adds the one
 * thing the guardrails comparison found missing on HUQAN's side -- a
 * *deterministic fix* stage -- and the rule that makes it safe:
 *
 *   fix, then re-validate, then (only if that still fails) reask.
 *
 * ## Why re-validation is structural, not a convention
 *
 * The failure mode a fix introduces is obvious: if a correction can be applied
 * and then simply accepted, the fix has become a way to skip the gate. So a fix
 * is never a plan on its own. `planReask` returns a fix plan only after the
 * caller-supplied `revalidate` has admitted the fixed value; the fallback order
 * is exactly the guardrails one:
 *
 * - a fix that produces nothing falls through to a reask;
 * - a fix whose value fails re-validation is **not applied** and falls through
 *   to a reask (`fixNotRevalidated`);
 * - a fix configured without a `revalidate` is refused
 *   (`reask_revalidation_required`) -- an un-checkable fix must never run;
 * - a `fix` or `revalidate` that throws is refused
 *   (`reask_revalidation_faulted`), the fail-closed direction, reported by the
 *   caller as a `captured` outcome.
 *
 * A fix that is re-validated opens no new authority: it carries no approval and
 * is checked against the very gate it would otherwise bypass.
 *
 * ## Budget and identity are the repair planner's
 *
 * This module keeps no counter and mints no id of its own. Every plan -- a fix
 * or a reask -- is produced by `createRepairPolicy().planRepair`, so the budget
 * survives a restart as persisted data, `policy-blocked` and `permanent`
 * failures are refused there (a fix must not open a policy block either), a
 * fresh `attemptId`/`invocationId` comes from the one place that already owns
 * that rule, and a fix draws on the same budget as a reask: a correction that
 * keeps failing the gate cannot retry forever.
 */

const { createRepairPolicy, FAILURE_KINDS } = require('./repair');

const CODES = Object.freeze({
  REVALIDATION_REQUIRED: 'reask_revalidation_required',
  REVALIDATION_FAULTED: 'reask_revalidation_faulted',
});

// A plan is one of these. `fix` is a corrected value that passed re-validation
// and needs no approval; `reask` is the ordinary repair that still waits for
// one.
const PLAN_KINDS = Object.freeze({
  FIX: 'fix',
  REASK: 'reask',
});

function refusal(code, cause) {
  return { ok: false, code, ...(cause ? { cause } : {}) };
}

/** Run the fix stage. Returns `{ value }`, or a fault when the fixer threw. */
function attemptFix(fix, failure) {
  if (typeof fix !== 'function') return { value: null };
  let value;
  try {
    value = fix(failure);
  } catch (error) {
    return { fault: String(error?.message || error) };
  }
  return { value: value === undefined ? null : value };
}

/**
 * Re-validate a fixed value. Returns `{ validated: true }` only when
 * `revalidate` admits it; a throw is a fault, a missing re-validator is a
 * refusal to plan at all, and a non-ok verdict is a rejection.
 */
function revalidateFix(revalidate, fixValue) {
  if (typeof revalidate !== 'function') return { required: true };
  let verdict;
  try {
    verdict = revalidate(fixValue);
  } catch (error) {
    return { fault: String(error?.message || error) };
  }
  return { validated: Boolean(verdict) && verdict.ok === true };
}

/**
 * @param {object} deps
 * @param {Function} [deps.fix] `(failure) => fixValue|null`; deterministic and
 *   pure. Omitted means every plan is a plain reask.
 * @param {Function} [deps.revalidate] `(fixValue) => {ok}`; required before any
 *   fix may be planned.
 * @param {object} [deps.policy] a `createRepairPolicy(...)` instance; defaults
 *   to the standard one so budget/identity semantics are shared, not copied.
 */
function createBoundedReask({ fix, revalidate, policy } = {}) {
  const repairPolicy = policy || createRepairPolicy();
  const hasFix = typeof fix === 'function';

  /**
   * Plan a reask, optionally with a deterministic fix. `failure` is
   * `{ kind, fingerprint?, stepId?, attemptId?, value? }`, `budget` the
   * persisted `{ attemptsUsed }`. Returns a plan or a refusal; never an
   * approval.
   *
   * The budget, fresh identity and backoff always come from the repair
   * planner: a fix is a retry of a failed step like any other, so it draws on
   * the same persisted budget and cannot reset it. What the fix adds is the
   * corrected value and the evidence of the correction -- not a shortcut.
   */
  function planReask({ failure, budget } = {}) {
    // The repair planner decides whether the failure may be retried at all:
    // `policy-blocked` and `permanent` are refused here, and an exhausted
    // budget proposes nothing. This runs first so a deterministic fix can
    // never open a policy block or spend budget the reask loop would refuse.
    const planned = repairPolicy.planRepair({ failure, budget });
    if (!planned.ok) return refusal(`reask_${planned.code}`);

    let fixValue = null;
    let fixNotRevalidated = false;
    if (hasFix) {
      const fixed = attemptFix(fix, failure);
      if (fixed.fault !== undefined) return refusal(CODES.REVALIDATION_FAULTED, fixed.fault);
      if (fixed.value !== null) {
        const validated = revalidateFix(revalidate, fixed.value);
        if (validated.required) return refusal(CODES.REVALIDATION_REQUIRED);
        if (validated.fault !== undefined) return refusal(CODES.REVALIDATION_FAULTED, validated.fault);
        if (validated.validated) fixValue = fixed.value;
        // The fix did not survive the gate: it is dropped and a reask is
        // planned instead, exactly as guardrails' fix_reask does.
        else fixNotRevalidated = true;
      }
    }

    return {
      ok: true,
      plan: Object.freeze({
        ...planned.plan,
        kind: fixValue !== null ? PLAN_KINDS.FIX : PLAN_KINDS.REASK,
        fixValue,
        fixNotRevalidated,
        // What the fix changed, so a receipt can show the correction rather
        // than only that one ran.
        before: fixValue !== null && failure && failure.value !== undefined ? failure.value : null,
        after: fixValue,
      }),
    };
  }

  return Object.freeze({
    planReask,
    limits: repairPolicy.limits,
    failureKinds: FAILURE_KINDS,
  });
}

module.exports = Object.freeze({ createBoundedReask, CODES, PLAN_KINDS });
