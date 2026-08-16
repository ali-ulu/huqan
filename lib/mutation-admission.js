'use strict';

/**
 * The mandatory mutation admission seam (P1).
 *
 * Gate 2 closed with `NO_EXISTING_UNIVERSAL_HOOK`: no existing point covers all
 * four write families, and the two candidates were rejected for opposite
 * reasons. This is the seam that closure required — above the mutation
 * machinery, below the callers:
 *
 *     caller
 *       -> MANDATORY ADMISSION            (this module)
 *       -> existing mutation machinery    (runMutationOnce, durability)
 *       -> graph sinks
 *       -> effect
 *
 * ## Admission is not durability
 *
 * This module never calls `runMutationOnce` and never becomes it. The two
 * answer different questions and are kept apart on purpose:
 *
 *   admission        - "may this mutation happen in this context?"
 *   runMutationOnce  - "is this mutation applied durably, exactly once?"
 *
 * Fusing them would tie receipt and retry semantics to identity semantics, so
 * that a change to one would drag the other. The caller's existing durability
 * behaviour passes through here untouched: whatever `mutate` did before,
 * including its own `runMutationOnce` call, it still does.
 *
 * ## What this does NOT do yet
 *
 * **It performs no identity checks.** P1-A's acceptance predicate — validity,
 * workspace binding, expiry, delegation scope, connector context — is not
 * evaluated here. Those controls are gates 3 through 8 and are connected only
 * after reachability, fail-closed behaviour and contract preservation have each
 * been measured.
 *
 * What it does is establish the two things those controls need and cannot add
 * for themselves: a choke point every mutation must pass through, and a context
 * complete enough to decide on. Turning the checks on later is then a change in
 * this one module rather than a hunt through call sites.
 *
 * ## Absence is declared, not inferred
 *
 * No caller in the repository carries an identity claim today. The honest way
 * to route them is not to invent one and not to let the field be missing, but
 * to make the absence explicit and give it a reason at the call site.
 *
 * `absent(reason)` produces that marker. It is accepted now and will be
 * rejected once enforcement is switched on, unless a policy explicitly permits
 * it. That ordering matters: when the checks arrive, every place lacking a
 * claim is already enumerated in source, so enabling enforcement is a policy
 * decision rather than an archaeology exercise.
 */

const CONTEXT_FIELDS = Object.freeze([
  'workspaceId',
  'action',
  'identityClaim',
  'delegationContext',
  'connectorContext',
]);

const ADMISSION_ERRORS = Object.freeze({
  CONTEXT_MISSING: 'admission.context_missing',
  CONTEXT_INCOMPLETE: 'admission.context_incomplete',
  CONTEXT_INVALID: 'admission.context_invalid',
  CALLER_SUPPLIED_CLOCK: 'admission.caller_supplied_clock',
  MUTATION_INVALID: 'admission.mutation_invalid',
});

const ABSENT = 'absent';

/**
 * Mark a context field as deliberately absent, with a reason.
 *
 * The reason is required. An unexplained absence is indistinguishable from an
 * oversight, and this marker exists precisely so the two can be told apart.
 */
function absent(reason) {
  if (typeof reason !== 'string' || reason.trim().length < 1) {
    throw new Error('an absent context field requires a reason');
  }
  return Object.freeze({ kind: ABSENT, reason: reason.trim() });
}

function isAbsent(value) {
  return Boolean(value) && typeof value === 'object' && value.kind === ABSENT;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function rejection(reason, detail = '') {
  return Object.freeze({ admitted: false, reason, detail });
}

/**
 * Build the admission seam.
 *
 * @param {{ clock?: () => Date }} options
 *   `clock` is receiver-owned and injected only so tests can pin it. A caller
 *   cannot reach it.
 */
function createMutationAdmission(options = {}) {
  const clock = typeof options.clock === 'function' ? options.clock : () => new Date();

  return Object.freeze({ admit, CONTEXT_FIELDS });

  /**
   * Admit a mutation, or refuse it.
   *
   * Fail-closed in the only way that matters: `mutate` is not called on any
   * path that refuses. A refusal is returned rather than thrown, so a caller
   * cannot lose the decision in a catch block that was written for its own
   * errors.
   *
   * @param {object} context
   * @param {() => unknown} mutate  the caller's existing mutation, unchanged
   * @returns {{ admitted: boolean, reason?: string, evaluationTime?: string, result?: unknown }}
   */
  function admit(context, mutate) {
    if (!context || typeof context !== 'object' || Array.isArray(context)) {
      return rejection(ADMISSION_ERRORS.CONTEXT_MISSING);
    }
    if (typeof mutate !== 'function') {
      return rejection(ADMISSION_ERRORS.MUTATION_INVALID);
    }

    // The evaluation clock is receiver-owned. A caller that supplies one is
    // refused rather than ignored: silently overwriting it would hide an
    // attempt to control expiry, and expiry is one of the five controls this
    // context exists to make decidable. lib/a2a/bounded-exchange.js holds the
    // same property for the A2A surface.
    if (Object.hasOwn(context, 'evaluationTime')) {
      return rejection(ADMISSION_ERRORS.CALLER_SUPPLIED_CLOCK);
    }

    const missing = CONTEXT_FIELDS.filter((field) => !Object.hasOwn(context, field));
    if (missing.length > 0) {
      return rejection(ADMISSION_ERRORS.CONTEXT_INCOMPLETE, missing.join(','));
    }

    // Present-but-empty is not the same as declared-absent, and only the second
    // is acceptable. Treating an empty string as "no identity" is how an
    // enforcement gap becomes invisible.
    if (!nonEmptyString(context.workspaceId)) {
      return rejection(ADMISSION_ERRORS.CONTEXT_INVALID, 'workspaceId');
    }
    if (!nonEmptyString(context.action)) {
      return rejection(ADMISSION_ERRORS.CONTEXT_INVALID, 'action');
    }
    for (const field of ['identityClaim', 'delegationContext', 'connectorContext']) {
      const value = context[field];
      const usable = isAbsent(value) || (Boolean(value) && typeof value === 'object' && !Array.isArray(value));
      if (!usable) return rejection(ADMISSION_ERRORS.CONTEXT_INVALID, field);
    }

    const evaluationTime = clock().toISOString();

    // P1-A's acceptance predicate is evaluated here once gates 3-8 land. Today
    // a complete context is admitted unconditionally, and that is stated rather
    // than implied: this seam is a choke point, not yet a control.
    const result = mutate();

    return Object.freeze({ admitted: true, evaluationTime, result });
  }
}

module.exports = Object.freeze({
  ABSENT,
  ADMISSION_ERRORS,
  CONTEXT_FIELDS,
  absent,
  createMutationAdmission,
  isAbsent,
});
