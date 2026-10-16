'use strict';

/**
 * Experience Phase 5 — bounded repair planning (#2391).
 *
 * The narrow core of the repair loop: failure classification and repair
 * proposals as pure data. Execution itself stays with the runtime seams
 * (#2378); this module decides whether a repair may be proposed at all,
 * and under which fresh identity and budget it would run.
 *
 * ## Structural guarantees (not conventions)
 *
 * - A repair starts a new attempt with a fresh identity. `planRepair`
 *   mints a new `attemptId` (and a new `invocationId` for the retried
 *   step) on every plan — there is no input through which a caller could
 *   reuse the failed attempt, so the E1 rule holds by construction.
 * - The previous approval is never inherited. The function signature has
 *   no field for it: every plan carries `approval: null` plus
 *   `approvalRequired: true`. A repair without a fresh approval cannot
 *   leave this module approved.
 * - A repair cannot open a policy block. `policy-blocked` failures are
 *   refused, full stop — escalation belongs to the policy owner, not to
 *   the retry loop.
 * - Budgets survive restarts because they are data. The caller passes the
 *   persisted budget in and persists `budgetAfter` out; this module keeps
 *   no counters, so a crash cannot reset them.
 * - Backoff is deterministic exponential with a cap — no jitter, no
 *   wall-clock reads — so a plan can be re-derived and compared exactly.
 *
 * ## Failure vocabulary
 *
 * Reuses the failure-fingerprint family (`lib/error-prevention/`) for
 * identity and `lib/agent-run-finalization.js` budget rows for persistence;
 * this module classifies by the caller-supplied `kind` and never invents
 * its own fingerprint scheme.
 */

const { randomUUID } = require('node:crypto');

const FAILURE_KINDS = Object.freeze({
  TRANSIENT: 'transient',
  PERMANENT: 'permanent',
  POLICY_BLOCKED: 'policy-blocked',
  UNKNOWN: 'unknown',
});

const CODES = Object.freeze({
  REPAIR_BLOCKED_BY_POLICY: 'repair_blocked_by_policy',
  NOT_REPAIRABLE: 'not_repairable',
  UNCLASSIFIED_FAILURE: 'unclassified_failure',
  BUDGET_EXHAUSTED: 'budget_exhausted',
  INVALID_INPUT: 'invalid_input',
});

const DEFAULTS = Object.freeze({
  maxAttempts: 3,
  backoffBaseMs: 1000,
  backoffMaxMs: 30000,
});

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function backoffMs(used, base, max) {
  return Math.min(base * (2 ** used), max);
}

function createRepairPolicy(options = {}) {
  const maxAttempts = Number.isInteger(options.maxAttempts) && options.maxAttempts > 0
    ? options.maxAttempts : DEFAULTS.maxAttempts;
  const backoffBaseMs = Number.isInteger(options.backoffBaseMs) && options.backoffBaseMs >= 0
    ? options.backoffBaseMs : DEFAULTS.backoffBaseMs;
  const backoffMaxMs = Number.isInteger(options.backoffMaxMs) && options.backoffMaxMs >= 0
    ? options.backoffMaxMs : DEFAULTS.backoffMaxMs;

  /**
   * Plan a repair. `failure` is `{ kind, fingerprint?, stepId? }`,
   * `budget` is the persisted `{ attemptsUsed }` (missing means zero).
   * Returns a plan or a refusal; never an approval.
   */
  function planRepair({ failure, budget } = {}) {
    if (!isRecord(failure) || !nonEmptyString(failure.kind)) {
      return { ok: false, code: CODES.INVALID_INPUT };
    }
    if (failure.kind === FAILURE_KINDS.POLICY_BLOCKED) {
      return { ok: false, code: CODES.REPAIR_BLOCKED_BY_POLICY };
    }
    if (failure.kind === FAILURE_KINDS.PERMANENT) {
      return { ok: false, code: CODES.NOT_REPAIRABLE };
    }
    if (failure.kind !== FAILURE_KINDS.TRANSIENT) {
      return { ok: false, code: CODES.UNCLASSIFIED_FAILURE };
    }
    const used = isRecord(budget) && Number.isInteger(budget.attemptsUsed) && budget.attemptsUsed >= 0
      ? budget.attemptsUsed : 0;
    if (used >= maxAttempts) {
      return { ok: false, code: CODES.BUDGET_EXHAUSTED };
    }
    const attemptId = randomUUID();
    return {
      ok: true,
      plan: Object.freeze({
        attemptId,
        invocationId: randomUUID(),
        priorAttemptId: nonEmptyString(failure.attemptId) || null,
        stepId: nonEmptyString(failure.stepId) || null,
        fingerprint: nonEmptyString(failure.fingerprint) || null,
        backoffMs: backoffMs(used, backoffBaseMs, backoffMaxMs),
        approval: null,
        approvalRequired: true,
        budgetAfter: Object.freeze({ attemptsUsed: used + 1, maxAttempts }),
      }),
    };
  }

  return Object.freeze({ planRepair, limits: Object.freeze({ maxAttempts, backoffBaseMs, backoffMaxMs }) });
}

module.exports = Object.freeze({ createRepairPolicy, FAILURE_KINDS, CODES });
