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
 * ## Identity evaluation is opt-in at the seam
 *
 * The seam now accepts a receiver-owned `identityEvaluator` option. When it is
 * configured, the evaluator receives the complete admission context plus the
 * receiver-stamped evaluation time, and the mutation callback runs only after
 * an explicit `{ decision: 'allow', allowed: true }` result. Evaluator errors,
 * malformed results and refusals fail closed.
 *
 * Existing callers remain explicit about their current absence markers until
 * they carry a receiver-owned identity claim. This preserves the migration
 * boundary: enabling identity enforcement is a deliberate caller composition
 * change, not an implicit reinterpretation of an absent claim.
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
 *
 * ## The seam reports which of the two it is, and the decision carries it out
 *
 * `identityEnforced` says whether the seam was constructed with a real
 * evaluator. That alone was not enough: every `admit()` result looked the same
 * whether identity was judged or merely declared absent, so the caller that
 * writes the receipt could not tell an enforced mutation from a declared-
 * absence one, and neither could the operator reading the audit trail (#3042).
 *
 * The decision now carries the state it was reached in:
 *
 *   `identityState`   `enforced` | `absent` | `not_evaluated`  -- always present
 *   `identityReason`  the declared reason, when the state is `absent`
 *
 * `enforced` means an evaluator was configured and returned allow. `absent`
 * means no evaluator was configured and the context's own identity claim was
 * declared absent with a reason -- the admission was reached on context shape
 * alone. `not_evaluated` is the third case: a real claim was supplied but no
 * evaluator judged it, so the field says exactly that rather than borrowing
 * either label. A caller must never read a missing field as `enforced`; the
 * field is always present, and `enforced` is the only state that means the
 * mutation was identity-gated.
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
  IDENTITY_EVALUATOR_INVALID: 'admission.identity_evaluator_invalid',
  IDENTITY_ENFORCEMENT_UNDECLARED: 'admission.identity_enforcement_undeclared',
  IDENTITY_REFUSED: 'admission.identity_refused',
  IDENTITY_POLICY_INVALID: 'admission.identity_policy_invalid',
  IDENTITY_POLICY_CONFLICT: 'admission.identity_policy_conflict',
  IDENTITY_REQUIRED: 'admission.identity_required',
});

const ABSENT = 'absent';

/**
 * The three identity states a decision can be reached in.
 *
 * Named as constants rather than left as bare strings so a caller cannot typo
 * `enforced` into a state that silently reads as a different one, and so the
 * receipts that persist them cite the same vocabulary the seam publishes.
 */
const IDENTITY_STATES = Object.freeze({
  ENFORCED: 'enforced',
  ABSENT: 'absent',
  NOT_EVALUATED: 'not_evaluated',
});

/**
 * What a seam does when it has no evaluator and the context declares the claim
 * absent.
 *
 * `optional` is today's behaviour: the admission is reached on context shape
 * alone and the decision reports `identityState: 'absent'`. `required` is the
 * fail-closed policy the issue asks for -- a seam built this way refuses every
 * mutation that arrives without an enforced identity, so a critical path cannot
 * quietly run on a declared absence.
 */
const IDENTITY_POLICIES = Object.freeze({
  OPTIONAL: 'optional',
  REQUIRED: 'required',
});

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
  // A forged marker without a real reason fails closed. The helper's
  // freeze/trim/reason guarantees are re-verified at the boundary, so a
  // caller that skips `absent(reason)` cannot manufacture a usable marker.
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  let kind;
  try {
    kind = value.kind;
  } catch (_) {
    return false;
  }
  if (kind !== ABSENT) return false;
  return nonEmptyString(value.reason);
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
 * `identityEvaluator` is **required**, and this is the P1-A property: a seam
 * cannot be constructed without deciding whether it enforces identity. Pass
 * either a receiver-owned evaluator function, or `absent(reason)` to say in
 * source that this construction does not enforce yet and why.
 *
 * Before this, the option defaulted to "no evaluator". That default is what
 * made the runtime's existence prove nothing: an unenforced seam and an
 * enforced one were written identically, so a new production construction
 * omitting the evaluator read as ordinary code and no reviewer or test could
 * see the difference. The same reasoning as `absent()` one level up, applied
 * to the control itself -- an undeclared absence is indistinguishable from an
 * oversight, so the declaration is mandatory and the omission is a TypeError.
 *
 * `identityEnforced` on the returned seam reports which of the two it is, so
 * the choice is readable at run time and not only at the construction site.
 * `identityState` says the same thing in the vocabulary the decisions use, and
 * `identityPolicy` reports the declared policy below.
 *
 * `identityPolicy` is `optional` by default and `required` to fail closed: a
 * `required` seam with no evaluator refuses every mutation whose context
 * declares its identity claim absent, rather than admitting it on context shape
 * alone. The two axes are checked against each other -- a `required` policy on
 * an enforced seam is refused as a contradiction.
 *
 * @param {{ clock?: () => Date, identityEvaluator: Function|object,
 *   identityPolicy?: 'optional'|'required' }} options
 *   `clock` is receiver-owned and injected only so tests can pin it. A caller
 *   cannot reach it.
 */
function createMutationAdmission(options = {}) {
  const clock = typeof options.clock === 'function' ? options.clock : () => new Date();

  if (!Object.hasOwn(options, 'identityEvaluator')) {
    throw new TypeError(ADMISSION_ERRORS.IDENTITY_ENFORCEMENT_UNDECLARED);
  }
  const declared = options.identityEvaluator;
  let identityEvaluator = null;
  if (typeof declared === 'function') {
    identityEvaluator = declared;
  } else if (!isAbsent(declared)) {
    // Includes `undefined` and `null` written out explicitly: an omission
    // spelled in full is still an omission, not a declaration.
    throw new TypeError(ADMISSION_ERRORS.IDENTITY_EVALUATOR_INVALID);
  }

  // The policy is only meaningful without an evaluator: an enforced seam has
  // already decided that identity is judged. Refusing the combination keeps the
  // two axes from contradicting each other.
  const declaredPolicy = options.identityPolicy === undefined ? IDENTITY_POLICIES.OPTIONAL : options.identityPolicy;
  if (declaredPolicy !== IDENTITY_POLICIES.OPTIONAL && declaredPolicy !== IDENTITY_POLICIES.REQUIRED) {
    throw new TypeError(ADMISSION_ERRORS.IDENTITY_POLICY_INVALID);
  }
  if (identityEvaluator !== null && declaredPolicy === IDENTITY_POLICIES.REQUIRED) {
    throw new TypeError(ADMISSION_ERRORS.IDENTITY_POLICY_CONFLICT);
  }

  return Object.freeze({
    admit,
    CONTEXT_FIELDS,
    identityEnforced: identityEvaluator !== null,
    identityState: identityEvaluator !== null ? IDENTITY_STATES.ENFORCED : IDENTITY_STATES.ABSENT,
    // The declared absence reason, when there is one. A caller that must record
    // its identity posture *before* it admits -- a receipt written ahead of the
    // write, say -- reads it here rather than re-deriving it from source.
    identityReason: isAbsent(declared) ? declared.reason : '',
    identityPolicy: declaredPolicy,
  });

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
    // A marker that claims to be `absent` but fails the real schema is
    // rejected outright: it must not fall back to the "plain object claim"
    // branch, because `{ kind: 'absent' }` without a reason is itself an
    // unexplained absence — the exact gap this invariant closes. A caller
    // can still supply a real object claim, but it may not impersonate the
    // absence marker.
    for (const field of ['identityClaim', 'delegationContext', 'connectorContext']) {
      const value = context[field];
      let usable = false;
      if (isAbsent(value)) {
        usable = true;
      } else if (Boolean(value) && typeof value === 'object' && !Array.isArray(value)) {
        let claimsAbsence = false;
        try {
          claimsAbsence = value.kind === ABSENT;
        } catch (_) {
          claimsAbsence = false;
        }
        if (claimsAbsence) return rejection(ADMISSION_ERRORS.CONTEXT_INVALID, field);
        usable = true;
      }
      if (!usable) return rejection(ADMISSION_ERRORS.CONTEXT_INVALID, field);
    }

    let evaluationTime;
    try {
      evaluationTime = clock().toISOString();
    } catch (_) {
      return rejection(ADMISSION_ERRORS.IDENTITY_EVALUATOR_INVALID, 'receiver clock failed');
    }

    // The state the decision was reached in travels with it. The three cases
    // are distinct on purpose: `enforced` means an evaluator judged the action,
    // `absent` means the context's own claim was declared absent and admission
    // ran on context shape alone, and `not_evaluated` means a real claim was
    // present but no evaluator judged it. Collapsing the last two would report
    // an unjudged real claim as a declared absence, which is the opposite of
    // what it is.
    let identityState = IDENTITY_STATES.NOT_EVALUATED;
    let identityReason = '';
    if (identityEvaluator !== null) {
      let decision;
      try {
        decision = identityEvaluator(Object.freeze({ ...context, evaluationTime }));
      } catch (_) {
        return rejection(ADMISSION_ERRORS.IDENTITY_EVALUATOR_INVALID);
      }
      if (!decision || decision.allowed !== true || decision.decision !== 'allow') {
        return rejection(
          ADMISSION_ERRORS.IDENTITY_REFUSED,
          typeof decision?.reason === 'string' ? decision.reason : 'identity evaluator refused',
        );
      }
      identityState = IDENTITY_STATES.ENFORCED;
    } else if (isAbsent(context.identityClaim)) {
      identityState = IDENTITY_STATES.ABSENT;
      identityReason = context.identityClaim.reason;
    }

    // A `required` policy refuses the declared-absence admission instead of
    // reaching the effect on context shape alone. This is the fail-closed
    // branch the issue asks for: a critical path that has not wired an
    // evaluator yet can still refuse rather than admit.
    //
    // It refuses `not_evaluated` too. A real claim that no evaluator judged is
    // still a mutation that arrived without an enforced identity, so admitting
    // it would leave the policy's own description false. `enforced` is the only
    // state a `required` seam admits.
    if (declaredPolicy === IDENTITY_POLICIES.REQUIRED && identityState !== IDENTITY_STATES.ENFORCED) {
      return rejection(
        ADMISSION_ERRORS.IDENTITY_REQUIRED,
        identityState === IDENTITY_STATES.ABSENT
          ? identityReason
          : 'identity claim was present but no evaluator judged it',
      );
    }

    // P1-A's acceptance predicate is opt-in until every production caller carries
    // a receiver-owned claim. Once configured, the evaluator runs before the
    // mutation callback and a refusal cannot reach the effect.
    //
    // The mutation receives the identity decision that admitted it, so the
    // record it writes can say which state it was written in. The state is
    // known before `mutate` runs -- that is the whole reason it is passed in
    // rather than read back afterwards, since by then the write has happened.
    const result = mutate(Object.freeze({
      identityState,
      ...(identityReason ? { identityReason } : {}),
    }));

    return Object.freeze({
      admitted: true,
      evaluationTime,
      result,
      identityState,
      ...(identityReason ? { identityReason } : {}),
    });
  }
}

module.exports = Object.freeze({
  ABSENT,
  ADMISSION_ERRORS,
  CONTEXT_FIELDS,
  IDENTITY_POLICIES,
  IDENTITY_STATES,
  absent,
  createMutationAdmission,
  isAbsent,
});
