'use strict';

/**
 * Experience — Capability Trust canary extension (design comment on #2397,
 * R3 Phase 9).
 *
 * Kept in its own file rather than inline in `capability-trust.js` purely
 * for `check:file-size` budget reasons (issue #328's 400-line ratchet):
 * `capability-trust.js` was under the threshold before this design and
 * must stay there, so the canary-related additions live here instead of
 * growing that file past it. This is NOT a parallel ladder or a separate
 * ownership boundary — `createCanaryExtension()` is called from inside
 * `createCapabilityTrustRegistry()` and operates on that same registry's
 * private `records` Map and closures (`rebindProcedure`, `toPublicEntry`,
 * `compositeKey`), so the four functions below are exactly as much part of
 * the Capability Trust ladder as `rebindProcedure`/`applyOperatorBlock`
 * are; they are simply defined in a sibling module for line-budget reasons.
 *
 * `promoteCanaryCandidate()` and `rollbackToPriorVersion()` never compute a
 * canary trial result or an admission decision themselves — the caller
 * runs `./canary.js`'s `evaluateCanaryTrial()` / `resolveAdmission()` and
 * hands the finished verdicts in, so this module stays the single ladder
 * authority without needing to know how a trial or an admission toggle
 * work internally (no import of `./canary.js` here, avoiding a cycle: the
 * dependency direction is caller -> canary.js and caller -> this module,
 * never canary.js -> capability-trust.js).
 *
 * `proposeDriftRollback()` reuses `./optimization-hypothesis.js` directly
 * against the capability's CURRENTLY-PROMOTED version and only ever
 * proposes a receipt — it never calls `rebindProcedure()` itself, so drift
 * detection can never silently revert a version on its own.
 *
 * #3469: an admission is accepted only when `./canary-admission.js` issued it
 * (a hand-written `{ admitted: true }` is refused), it names this workspace
 * and capability, and it has not authorized another move already. That
 * module imports nothing local, so this adds no cycle.
 */

const crypto = require('node:crypto');
const { detectSuccessRateDecline, detectCostRegression } = require('./optimization-hypothesis');
const { isIssuedAdmission, isAdmissionSpent, spendAdmission } = require('./canary-admission');

/** Null when `admission` may authorize one move on this capability, else the refusal code. */
function admissionRefusal(admission, workspaceId, capabilityId, notAdmittedCode) {
  if (!isIssuedAdmission(admission)) return notAdmittedCode;
  if (admission.receipt?.workspaceId !== workspaceId || admission.receipt?.capabilityId !== capabilityId) {
    return 'admission_subject_mismatch';
  }
  return isAdmissionSpent(admission) ? 'admission_already_used' : null;
}

const POSITIVE = 'positive_procedure';
const NEGATIVE = 'negative_example';

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function stableKey(value) {
  if (value === undefined) return '';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableKey(value[k])}`).join(',')}}`;
}

/**
 * @param {object} deps
 * @param {Map<string, object>} deps.records the registry's private record store
 * @param {(workspaceId: string, capabilityId: string) => string} deps.compositeKey
 * @param {(value: unknown) => boolean} deps.nonEmptyString
 * @param {Function} deps.rebindProcedure the registry's own rebind function
 * @param {(record: object) => object} deps.toPublicEntry
 */
function createCanaryExtension({
  records, compositeKey, nonEmptyString, rebindProcedure, toPublicEntry,
}) {
  /**
   * Promote a canary-passed candidate. This is an ordinary rebind (per
   * #2394's existing rule, forcing `probationary`) gated by two
   * independent refusals: the canary trial must have actually passed, and
   * the promotion must be admitted (an explicit approval or an active,
   * receipted auto-promote toggle). Neither check is optional: a canary
   * pass with no admission record refuses here exactly like a promotion
   * attempt with no canary result at all (acceptance test 5).
   */
  function promoteCanaryCandidate({
    workspaceId, capabilityId, candidateProcedureVersion, canaryResult, admission, atEventId, at = Date.now(),
  } = {}) {
    const record = records.get(compositeKey(workspaceId, capabilityId));
    if (!record) return { ok: false, code: 'not_found' };
    if (!nonEmptyString(candidateProcedureVersion)) return { ok: false, code: 'invalid_procedure_version' };
    if (!isRecord(canaryResult) || canaryResult.status !== 'passed') {
      return { ok: false, code: 'canary_not_passed' };
    }
    const refused = admissionRefusal(admission, workspaceId, capabilityId, 'promotion_not_admitted');
    if (refused) return { ok: false, code: refused };
    const priorProcedureVersion = record.boundProcedureVersion;
    const result = rebindProcedure({
      workspaceId, capabilityId, newProcedureVersion: candidateProcedureVersion,
      reason: `canary_promotion:${admission.mode}`, atEventId, at,
    });
    if (!result.ok) return result;
    spendAdmission(admission);
    // Appended, never rewritten -- exactly like `history` (acceptance test 9).
    record.promotionReceipts.push(Object.freeze({
      receiptId: `promotion_${sha256(stableKey({
        workspaceId, capabilityId, priorProcedureVersion, candidateProcedureVersion, at,
      })).slice(0, 16)}`,
      kind: 'promotion',
      priorProcedureVersion,
      newProcedureVersion: candidateProcedureVersion,
      admissionMode: admission.mode,
      admissionReceipt: admission.receipt || null,
      canaryReason: canaryResult.reason || null,
      at,
    }));
    return { ok: true, entry: toPublicEntry(record) };
  }

  /**
   * Rollback: the same rebind mechanism pointed at a capability's PRIOR
   * `boundProcedureVersion` -- not a special "undo" code path, an ordinary
   * promotion-shaped event (also admission-gated, same as
   * `promoteCanaryCandidate()`). `targetProcedureVersion` must actually
   * have been bound before (found either in `history`'s
   * `procedureVersionAtChange` trail or in raw `events`) -- rollback
   * refuses rather than assumes when asked to "restore" a version this
   * capability never had, and never reconstructs anything: because
   * `rebindProcedure()` never deletes evidence, the prior version's window
   * is simply still there (see `getEvidenceForVersion()` below).
   */
  function rollbackToPriorVersion({
    workspaceId, capabilityId, targetProcedureVersion, admission, reason = 'rollback', atEventId, at = Date.now(),
  } = {}) {
    const record = records.get(compositeKey(workspaceId, capabilityId));
    if (!record) return { ok: false, code: 'not_found' };
    if (!nonEmptyString(targetProcedureVersion)) return { ok: false, code: 'invalid_procedure_version' };
    if (targetProcedureVersion === record.boundProcedureVersion) {
      return { ok: false, code: 'already_bound' };
    }
    const wasPriorVersion = record.history.some((h) => h.procedureVersionAtChange === targetProcedureVersion)
      || record.events.some((e) => e.procedureVersion === targetProcedureVersion);
    if (!wasPriorVersion) return { ok: false, code: 'unknown_prior_version' };
    const refused = admissionRefusal(admission, workspaceId, capabilityId, 'rollback_not_admitted');
    if (refused) return { ok: false, code: refused };
    const fromProcedureVersion = record.boundProcedureVersion;
    const result = rebindProcedure({
      workspaceId, capabilityId, newProcedureVersion: targetProcedureVersion,
      reason: `rollback:${reason}:${admission.mode}`, atEventId, at,
    });
    if (!result.ok) return result;
    spendAdmission(admission);
    record.promotionReceipts.push(Object.freeze({
      receiptId: `rollback_${sha256(stableKey({
        workspaceId, capabilityId, fromProcedureVersion, targetProcedureVersion, at,
      })).slice(0, 16)}`,
      kind: 'rollback',
      fromProcedureVersion,
      toProcedureVersion: targetProcedureVersion,
      admissionMode: admission.mode,
      admissionReceipt: admission.receipt || null,
      reason,
      at,
    }));
    return { ok: true, entry: toPublicEntry(record) };
  }

  /**
   * Independent evidence query for one specific procedure version,
   * regardless of whether it is the currently-bound version. This is what
   * proves rollback "does not need to reconstruct history": both the
   * pre-rollback and post-rollback versions' evidence are independently
   * queryable through this same function, before and after a rollback
   * (acceptance test 7).
   */
  function getEvidenceForVersion(workspaceId, capabilityId, procedureVersion) {
    const record = records.get(compositeKey(workspaceId, capabilityId));
    if (!record) return { ok: false, code: 'not_found' };
    const events = record.events.filter((e) => e.procedureVersion === procedureVersion
      && (e.learningEligibility === POSITIVE || e.learningEligibility === NEGATIVE));
    return {
      ok: true,
      procedureVersion,
      totalCount: events.length,
      positiveCount: events.filter((e) => e.learningEligibility === POSITIVE).length,
      negativeCount: events.filter((e) => e.learningEligibility === NEGATIVE).length,
      events: Object.freeze(events.slice()),
    };
  }

  /**
   * Drift detection: reuses `./optimization-hypothesis.js`'s
   * `success_rate_decline` / `cost_regression` detectors against the
   * capability's CURRENTLY-PROMOTED version. Firing past a configured
   * severity only ever PROPOSES a rollback receipt for admission -- it
   * never calls `rollbackToPriorVersion()` itself, so drift can never
   * revert a version without a human/policy admission step (acceptance
   * test 8). `promotionBaseline` is the `{ rateAtLastPromotion,
   * totalCostAtLastPromotion }` snapshot recorded when the currently-bound
   * version was promoted -- this function does not invent one.
   */
  function proposeDriftRollback({
    workspaceId, capabilityId, currentEvents, promotionBaseline, priorProcedureVersion = null, now = Date.now(),
  } = {}) {
    const record = records.get(compositeKey(workspaceId, capabilityId));
    if (!record) return { ok: false, code: 'not_found' };
    if (!isRecord(promotionBaseline)
      || typeof promotionBaseline.rateAtLastPromotion !== 'number'
      || typeof promotionBaseline.totalCostAtLastPromotion !== 'number') {
      return { ok: false, code: 'invalid_promotion_baseline' };
    }
    const successDecline = detectSuccessRateDecline({
      capabilityId, events: currentEvents, rateAtLastPromotion: promotionBaseline.rateAtLastPromotion, now,
    });
    const costRegression = detectCostRegression({
      capabilityId, events: currentEvents, totalCostAtLastPromotion: promotionBaseline.totalCostAtLastPromotion, now,
    });
    if (!successDecline.ok || !costRegression.ok) return { ok: false, code: 'invalid_drift_inputs' };

    const driftDetected = successDecline.hypothesis.fires || costRegression.hypothesis.fires;
    const hypotheses = Object.freeze({
      successRateDecline: successDecline.hypothesis, costRegression: costRegression.hypothesis,
    });
    if (!driftDetected) {
      return { ok: true, driftDetected: false, hypotheses, proposedRollbackReceipt: null };
    }
    const proposalPayload = {
      workspaceId,
      capabilityId,
      currentProcedureVersion: record.boundProcedureVersion,
      priorProcedureVersion,
      firedHypothesisHashes: [
        successDecline.hypothesis.fires ? successDecline.hypothesis.hypothesisHash : null,
        costRegression.hypothesis.fires ? costRegression.hypothesis.hypothesisHash : null,
      ].filter(Boolean),
      at: now,
    };
    const proposedRollbackReceipt = Object.freeze({
      receiptId: `drift_rollback_${sha256(stableKey(proposalPayload)).slice(0, 16)}`,
      receiptKind: 'canary_drift_rollback_proposal',
      ...proposalPayload,
      applied: false,
    });
    return { ok: true, driftDetected: true, hypotheses, proposedRollbackReceipt };
  }

  return Object.freeze({
    promoteCanaryCandidate, rollbackToPriorVersion, getEvidenceForVersion, proposeDriftRollback,
  });
}

module.exports = Object.freeze({ createCanaryExtension });
