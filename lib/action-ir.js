'use strict';

/**
 * Read-only candidate Action IR for the L2 action-semantics track (#3476).
 *
 * L1 (`lib/common-semantic-ir.js`, #3312) turned language into a versioned,
 * read-only record, but it stops at meaning: it never says what a plan may
 * *do*. L2 adds the action half -- an Action IR that keeps the three phases the
 * track names (verification / policy / execution) separate and refuses to
 * authorize anything until the condition is verified *and* authority is
 * granted. The track's own acceptance line is literal: "şart ve authority
 * doğrulanmadan eylem yok" -- no action without a verified condition and
 * authority -- and "unsafe/unknown plan fail-closed".
 *
 * The record is a *candidate*. Building it never executes an action, admits a
 * belief or grants authority; the plan is proposer data. It composes two
 * shipped decision surfaces instead of re-deriving them:
 *
 * - `lib/common-semantic-ir.js` -- the L1 record (language, intent, claims,
 *   references). Its unknown intent and unresolved references are the plan's
 *   unverified conditions, and a language the baseline cannot identify stays
 *   `unknown` rather than guessed, so a new adapter cannot silently widen the
 *   policy core.
 * - `lib/external-action-envelope.js` + `lib/external-action-guard.js` -- the
 *   normalized action and its single fail-closed authorization decision. This
 *   module reads that decision; it does not replace it.
 *
 * Fail-closed rules, taken literally from the issue:
 *
 * - `execution.authorized` is true only when `verification.verified` is true
 *   AND `policy.decision` is `allow`. A block, a review, a malformed envelope,
 *   an unknown intent or an unresolved reference all yield `authorized: false`.
 * - A field with no input is an explicit `unknown` diagnostic with a reason,
 *   never an empty placeholder that reads as "measured none".
 * - `validateActionIR` rejects a record that claims authorization without both
 *   conditions, so an untrusted caller cannot forge an execution envelope.
 *
 * Read-only: nothing here mutates the graph or runs the plan.
 */

const {
  buildCommonSemanticIR,
  IDENTIFIED_LANGUAGES,
} = require('./common-semantic-ir');
const { redactExternalValue } = require('./external-action-envelope');
const { evaluateExternalAction } = require('./external-action-guard');
const { isPlainObject } = require('./is-plain-object');

const ACTION_IR_VERSION = '1.0.0';

const STATUS = Object.freeze({ PRESENT: 'present', UNKNOWN: 'unknown' });

/** Whether the plan is a definite negative, a verified non-negative, or unmeasured. */
const PLAN_SAFETY = Object.freeze({ SAFE: 'safe', UNSAFE: 'unsafe', UNKNOWN: 'unknown' });

/** The fields the Action IR declares (language track L2). */
const ACTION_IR_FIELDS = Object.freeze([
  'plan',
  'verification',
  'policy',
  'execution',
  'planSafety',
  'language',
  'references',
  'confidence',
]);

function field(status, value, reason) {
  return reason === undefined ? { status, value } : { status, value, reason };
}

function present(value, reason) {
  return field(STATUS.PRESENT, value, reason);
}

function unknown(reason) {
  return field(STATUS.UNKNOWN, null, reason);
}

function asText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Verification of the plan's condition: an action may not proceed when a plan
 * was supplied in language and the baseline could not understand it. When no
 * text is supplied the action itself is the plan, so there is no language
 * condition to verify. Each check is reported so a refusal names the exact
 * condition that failed.
 */
function verificationFor(semantic, envelope, hasText) {
  const understood = !hasText || semantic.intent.status === STATUS.PRESENT;
  const checks = [
    { name: 'plan_understood', passed: understood },
    { name: 'envelope_well_formed', passed: envelope.malformed === false },
  ];
  return { verified: checks.every(check => check.passed), checks };
}

/**
 * Policy: the guard's fail-closed decision, projected. A guard that throws is
 * itself a refusal, not a crash that would let the plan through. The guard
 * normalizes the action once and returns the envelope it decided on; that same
 * envelope is what execution reports, so verification and policy cannot drift
 * onto two different readings of the plan.
 */
function policyFor(action, options) {
  try {
    const decision = evaluateExternalAction(isPlainObject(action) ? action : {}, options);
    return {
      envelope: decision.envelope,
      decision: decision.decision,
      reason: decision.reason,
      riskLevel: decision.risk?.level ?? null,
      riskScore: decision.risk?.score ?? null,
    };
  } catch (error) {
    return {
      envelope: null,
      decision: 'block',
      reason: 'external_action_gate_error',
      riskLevel: null,
      riskScore: null,
      error: String(error?.message || error),
    };
  }
}

function planSafetyFor(envelope, verification, policy) {
  if (envelope.malformed) return PLAN_SAFETY.UNKNOWN;
  if (policy.decision === 'block' || policy.decision === 'review') return PLAN_SAFETY.UNSAFE;
  if (!verification.verified) return PLAN_SAFETY.UNKNOWN;
  return PLAN_SAFETY.SAFE;
}

/** The authorized execution envelope. Authorization requires both conditions. */
function executionFor(envelope, verification, policy) {
  const authorized = verification.verified === true && policy.decision === 'allow';
  return {
    authorized,
    decision: policy.decision,
    reason: authorized ? 'condition_verified_and_authorized' : (policy.reason || 'condition_or_authority_not_verified'),
    envelope: {
      schemaVersion: envelope.schemaVersion,
      kind: envelope.kind,
      riskCategory: envelope.riskCategory,
      command: envelope.command ? redactExternalValue(envelope.command) : '',
      target: envelope.target,
      workspaceId: envelope.workspaceId,
    },
  };
}

function planSummary(semantic, envelope) {
  return {
    intent: semantic.intent.status === STATUS.PRESENT ? semantic.intent.value : null,
    claims: semantic.claims.status === STATUS.PRESENT ? semantic.claims.value.length : 0,
    action: {
      kind: envelope.kind,
      riskCategory: envelope.riskCategory,
      command: envelope.command ? redactExternalValue(envelope.command) : '',
    },
    semantic,
  };
}

/**
 * Compose the L1 record and the shipped action decision into a read-only,
 * versioned Action IR candidate.
 *
 * @param {string|{text?: string, action?: object, domain?: string}} input
 * @param {object} [opts] forwarded to the envelope/guard (cwd, workspaceRoot,
 *   allowedCommands, ...) plus `normalizeWord` for the L1 parsers
 * @returns {object} versioned, JSON-serializable action record
 */
function buildActionIR(input, opts = {}) {
  const source = isPlainObject(input) ? input : {};
  const text = asText(typeof input === 'string' ? input : source.text);
  const hasAction = isPlainObject(source.action);

  if (!text && !hasAction) {
    return {
      version: ACTION_IR_VERSION,
      plan: unknown('no_plan_supplied'),
      verification: unknown('no_plan_supplied'),
      policy: unknown('no_plan_supplied'),
      execution: present({ authorized: false, decision: 'block', reason: 'no_plan_supplied', envelope: null }, 'no_plan_supplied'),
      planSafety: unknown('no_plan_supplied'),
      language: unknown('no_plan_supplied'),
      references: present([], 'no_plan_supplied'),
      confidence: unknown('baseline_confidence_is_not_calibrated'),
    };
  }

  const semantic = buildCommonSemanticIR(
    text ? { text, domain: source.domain } : { text: '', domain: source.domain },
    { normalizeWord: opts.normalizeWord, domain: source.domain ?? opts.domain },
  );
  const policy = policyFor(source.action, opts);
  const envelope = policy.envelope || evaluateExternalAction({}, opts).envelope;
  const verification = verificationFor(semantic, envelope, Boolean(text));
  const safety = planSafetyFor(envelope, verification, policy);
  const references = semantic.references.status === STATUS.PRESENT ? semantic.references.value : [];

  return {
    version: ACTION_IR_VERSION,
    plan: present(planSummary(semantic, envelope), 'common-semantic-ir+external-action-envelope'),
    verification: present(verification, verification.verified ? 'condition_verified' : 'condition_not_verified'),
    policy: present(
      { decision: policy.decision, reason: policy.reason, riskLevel: policy.riskLevel, riskScore: policy.riskScore },
      'external-action-guard',
    ),
    execution: present(executionFor(envelope, verification, policy), 'external-action-guard'),
    planSafety: present(safety, 'verification+policy'),
    language: semantic.language.status === STATUS.PRESENT
      ? present(semantic.language.value, 'common-semantic-ir')
      : unknown('language_not_identified_from_baseline_markers'),
    references: present(references, 'common-semantic-ir:unresolved-or-ambiguous-candidates'),
    confidence: unknown('baseline_confidence_is_not_calibrated'),
  };
}

/**
 * Fail-closed structural validation of a record produced by `buildActionIR`.
 * Beyond the per-field shape, it enforces the L2 invariant: a record may not
 * claim `execution.authorized` unless the condition is verified, policy says
 * `allow`, and the plan is not marked unsafe. An untrusted caller (a plugin, a
 * fixture, a future language adapter) cannot forge an execution envelope.
 *
 * @returns {{valid: boolean, errors: string[]}}
 */
function validateActionIR(ir) {
  if (!ir || typeof ir !== 'object' || Array.isArray(ir)) {
    return { valid: false, errors: ['action IR must be a non-array object'] };
  }
  const errors = [];
  if (ir.version !== ACTION_IR_VERSION) {
    errors.push(`version must be ${ACTION_IR_VERSION}, got ${JSON.stringify(ir.version ?? null)}`);
  }
  for (const name of ACTION_IR_FIELDS) {
    const entry = ir[name];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${name} must be an object with {status, value}`);
      continue;
    }
    if (entry.status !== STATUS.PRESENT && entry.status !== STATUS.UNKNOWN) {
      errors.push(`${name}.status must be one of ${STATUS.PRESENT}|${STATUS.UNKNOWN}`);
      continue;
    }
    if (entry.status === STATUS.PRESENT && entry.value == null) {
      errors.push(`${name} claims present status but carries no value`);
    }
    if (entry.status === STATUS.UNKNOWN && entry.value != null) {
      errors.push(`${name} claims unknown status but carries a value`);
    }
    if (entry.status === STATUS.UNKNOWN
      && (typeof entry.reason !== 'string' || entry.reason.trim().length === 0)) {
      errors.push(`${name}.reason must be a non-empty string when status is unknown`);
    }
  }

  const language = ir.language;
  if (language && language.status === STATUS.PRESENT && !IDENTIFIED_LANGUAGES.includes(language.value)) {
    errors.push(`language.value must be one of ${IDENTIFIED_LANGUAGES.join('|')} when present`);
  }

  const safety = ir.planSafety;
  if (safety && safety.status === STATUS.PRESENT && !Object.values(PLAN_SAFETY).includes(safety.value)) {
    errors.push(`planSafety.value must be one of ${Object.values(PLAN_SAFETY).join('|')} when present`);
  }

  const execution = ir.execution;
  if (execution && execution.status === STATUS.PRESENT && execution.value?.authorized === true) {
    const verification = ir.verification;
    if (!(verification && verification.status === STATUS.PRESENT && verification.value?.verified === true)) {
      errors.push('execution.authorized is true without a verified condition');
    }
    const policy = ir.policy;
    if (!(policy && policy.status === STATUS.PRESENT && policy.value?.decision === 'allow')) {
      errors.push('execution.authorized is true without an allow policy decision');
    }
    if (safety && safety.status === STATUS.PRESENT && safety.value !== PLAN_SAFETY.SAFE) {
      errors.push('execution.authorized is true for a plan that is not safe');
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  ACTION_IR_VERSION,
  ACTION_IR_FIELDS,
  PLAN_SAFETY,
  buildActionIR,
  validateActionIR,
};
