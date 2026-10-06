'use strict';

/**
 * I5 (#3469): the reflective learning loop for a learned procedure, rule or
 * model version — propose -> canary -> promote -> observe -> rollback —
 * composed from the existing primitives and adding no second authority.
 *
 * - The capability trust ladder (`./capability-trust.js`) owns the binding:
 *   promotion and rollback are its `promoteCanaryCandidate()` and
 *   `rollbackToPriorVersion()`.
 * - `./canary.js` decides the trial. The loop computes the verdict from the
 *   measured runs; it never accepts a caller-supplied `passed`.
 * - `./canary-admission.js` grants the authority. The loop always passes the
 *   candidate's proposer and every learner principal as `proposerIds`, so a
 *   learner cannot approve, or switch on auto-promotion for, its own change.
 *
 * A learned change may not widen authority. Every proposal must declare its
 * `authorityDelta`; a declaration that touches scope, policy, approval or
 * capability, or that cannot be read plainly, is refused at proposal time,
 * however good its canary later looks: that is a policy change for a person,
 * never an output of learning (B8). The declaration is the proposer's own
 * claim -- this loop does not derive it from the artifact -- so it stops a
 * declared widening, not an undeclared one.
 *
 * Approvals are bound to a move: `{ kind: 'promotion' | 'rollback',
 * candidateVersion }`. An unbound approval, or one for another version or
 * direction, does not authorize the loop, and a mismatched request leaves the
 * reviewer's approval in place. Promotion refuses when the bound version moved
 * since the proposal; rollback refuses when the candidate is no longer bound.
 *
 * Out of scope here: the ladder's own `rebindProcedure()` still moves a
 * binding without admission for whoever holds the registry, and approver ids
 * are not authenticated; the boundary is as complete as `learnerPrincipals`.
 *
 * Observation only ever proposes a rollback (drift detection through the
 * ladder's `proposeDriftRollback()`); the rollback itself needs its own
 * independent admission, as `./capability-trust-canary-extension.js`
 * requires. An admin's standing toggle can make that automatic; the learner
 * cannot. The audit trail is append-only.
 */

const crypto = require('node:crypto');
const { types } = require('node:util');
const { evaluateCanaryTrial, CANARY_STATUS } = require('./canary');
const { DEFAULT_TRAILING_WINDOW_RUNS, DEFAULT_TRAILING_WINDOW_DAYS } = require('./optimization-hypothesis');

const ARTIFACT_TYPES = Object.freeze(['procedure', 'rule', 'model']);
const AUTHORITY_SURFACES = Object.freeze(['scope', 'policy', 'approval', 'capability']);
const STATES = Object.freeze({
  PROPOSED: 'proposed', REFUSED: 'refused', CANARY_PASSED: 'canary_passed', CANARY_FAILED: 'canary_failed',
  PROMOTED: 'promoted', ROLLBACK_PROPOSED: 'rollback_proposed', ROLLED_BACK: 'rolled_back',
});
const DAY_MS = 24 * 60 * 60 * 1000;

function text(value) { return typeof value === 'string' && value.length > 0 && value.length <= 256; }
function fail(code, extra = {}) { return Object.freeze({ ok: false, code, ...extra }); }
function candidateIdOf(input) {
  return `rc_${crypto.createHash('sha256').update(JSON.stringify(input), 'utf8').digest('hex').slice(0, 24)}`;
}
/**
 * Read the proposer's declaration of what the change does to authority. It is
 * required, must be a plain object, and is read through every own key
 * (symbols and non-enumerable ones included) so nothing hides from the check.
 * Only `{ surface: null }` entries for known surfaces mean "untouched".
 */
function declaredWidening(delta) {
  if (delta === undefined) return { code: 'authority_delta_required' };
  if (!delta || typeof delta !== 'object' || types.isProxy(delta)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(delta))) return { code: 'invalid_authority_delta' };
  const widened = [];
  for (const key of Reflect.ownKeys(delta)) {
    const descriptor = Object.getOwnPropertyDescriptor(delta, key);
    if (typeof key !== 'string' || !AUTHORITY_SURFACES.includes(key) || !('value' in descriptor)) return { code: 'invalid_authority_delta' };
    if (descriptor.value !== null) widened.push(key);
  }
  return widened.length ? { code: 'authority_expansion', widened } : null;
}
/** Same trailing window as the drift detectors: the smaller of last-N-runs and last-T-days. */
function windowSize(events, now) {
  const scoped = events.filter((e) => e && (e.learningEligibility === 'positive_procedure' || e.learningEligibility === 'negative_example'));
  const withinDays = scoped.filter((e) => e.occurredAt >= now - DEFAULT_TRAILING_WINDOW_DAYS * DAY_MS).length;
  return Math.min(withinDays, Math.min(scoped.length, DEFAULT_TRAILING_WINDOW_RUNS));
}

function createReflectivePromotion({ trust, admissions, learnerPrincipals = [] } = {}) {
  if (!trust || typeof trust.promoteCanaryCandidate !== 'function' || !admissions || typeof admissions.resolveAdmission !== 'function') {
    throw new TypeError('capability trust ladder and admission registry required');
  }
  if (!Array.isArray(learnerPrincipals) || !learnerPrincipals.every(text)) throw new TypeError('learnerPrincipals must be ids');
  const candidates = new Map();
  const audit = [];

  function record(candidate, event, details = {}) {
    audit.push(Object.freeze({ candidateId: candidate.candidateId, event, state: candidate.state, at: Date.now(), ...details }));
  }
  // Only an approval bound to this kind of move and this candidate version
  // counts; an approval for another candidate or direction is not consumed.
  function authorityFor(candidate, promotionId, kind) {
    return admissions.resolveAdmission({ workspaceId: candidate.workspaceId, capabilityId: candidate.capabilityId,
      promotionId, proposerIds: [candidate.proposedBy, ...learnerPrincipals],
      subject: { kind, candidateVersion: candidate.candidateVersion } });
  }
  function boundVersion(candidate) {
    return trust.get(candidate.workspaceId, candidate.capabilityId).boundProcedureVersion;
  }

  function propose({ workspaceId, capabilityId, artifactType, candidateVersion, proposedBy, authorityDelta } = {}) {
    if (![workspaceId, capabilityId, candidateVersion, proposedBy].every(text) || !ARTIFACT_TYPES.includes(artifactType)) {
      return fail('invalid_proposal');
    }
    // The ladder answers an unknown capability with an entry bound to nothing.
    const current = trust.get(workspaceId, capabilityId);
    if (!current || !text(current.boundProcedureVersion)) return fail('not_found');
    const refusal = declaredWidening(authorityDelta);
    const candidate = { candidateId: candidateIdOf([workspaceId, capabilityId, artifactType, candidateVersion, proposedBy]),
      workspaceId, capabilityId, artifactType, candidateVersion, proposedBy, priorVersion: current.boundProcedureVersion,
      state: refusal ? STATES.REFUSED : STATES.PROPOSED, trial: null, promotionBaseline: null };
    if (candidates.has(candidate.candidateId)) return fail('duplicate_proposal');
    candidates.set(candidate.candidateId, candidate);
    record(candidate, 'proposed', refusal ? { refusal: refusal.code, widened: refusal.widened || [] } : {});
    if (refusal) return fail(refusal.code, { candidateId: candidate.candidateId, widened: refusal.widened || [] });
    return Object.freeze({ ok: true, candidateId: candidate.candidateId, state: candidate.state });
  }

  function evaluateCanary({ candidateId, candidateRuns, baselineWindowRuns, startAt, now } = {}) {
    const candidate = candidates.get(candidateId);
    if (!candidate) return fail('unknown_candidate');
    if (![STATES.PROPOSED, STATES.CANARY_FAILED].includes(candidate.state)) return fail('invalid_state', { state: candidate.state });
    const trial = evaluateCanaryTrial({ candidateRuns, baselineWindowRuns, startAt, now });
    if (!trial.ok) return trial;
    candidate.trial = trial;
    if (trial.status === CANARY_STATUS.PASSED) candidate.state = STATES.CANARY_PASSED;
    else if (trial.status === CANARY_STATUS.FAILED) candidate.state = STATES.CANARY_FAILED;
    record(candidate, 'canary_evaluated', { status: trial.status, reason: trial.reason });
    return Object.freeze({ ok: true, state: candidate.state, trial });
  }

  function promote({ candidateId, promotionId } = {}) {
    const candidate = candidates.get(candidateId);
    if (!candidate) return fail('unknown_candidate');
    if (candidate.state !== STATES.CANARY_PASSED || !text(promotionId)) return fail('invalid_state', { state: candidate.state });
    // The canary compared against the version bound at proposal time; if
    // another promotion moved it since, that comparison no longer holds.
    if (boundVersion(candidate) !== candidate.priorVersion) return fail('stale_prior_version');
    const admission = authorityFor(candidate, promotionId, 'promotion');
    if (!admission.ok || admission.admitted !== true) {
      record(candidate, 'promotion_refused', { code: admission.code });
      return fail(admission.code || 'promotion_not_admitted');
    }
    const promoted = trust.promoteCanaryCandidate({ workspaceId: candidate.workspaceId, capabilityId: candidate.capabilityId,
      candidateProcedureVersion: candidate.candidateVersion, canaryResult: candidate.trial, admission });
    if (!promoted.ok) return promoted;
    const metrics = candidate.trial.candidateMetrics;
    candidate.promotionBaseline = { rateAtLastPromotion: metrics.negativeRate,
      meanCostAtLastPromotion: metrics.totalCount ? metrics.totalCost / metrics.totalCount : 0 };
    candidate.state = STATES.PROMOTED;
    record(candidate, 'promoted', { admissionMode: admission.mode, authorityId: admission.receipt.approverId || admission.receipt.adminId });
    return Object.freeze({ ok: true, state: candidate.state, entry: promoted.entry });
  }

  function observe({ candidateId, currentEvents, now = Date.now() } = {}) {
    const candidate = candidates.get(candidateId);
    if (!candidate) return fail('unknown_candidate');
    if (candidate.state !== STATES.PROMOTED) return fail('invalid_state', { state: candidate.state });
    const events = Array.isArray(currentEvents) ? currentEvents : [];
    const drift = trust.proposeDriftRollback({ workspaceId: candidate.workspaceId, capabilityId: candidate.capabilityId,
      currentEvents: events, priorProcedureVersion: candidate.priorVersion, now,
      promotionBaseline: { rateAtLastPromotion: candidate.promotionBaseline.rateAtLastPromotion,
        totalCostAtLastPromotion: candidate.promotionBaseline.meanCostAtLastPromotion * windowSize(events, now) } });
    if (!drift.ok) return drift;
    if (drift.driftDetected) {
      candidate.state = STATES.ROLLBACK_PROPOSED;
      record(candidate, 'rollback_proposed', { receiptId: drift.proposedRollbackReceipt.receiptId });
    }
    return Object.freeze({ ok: true, state: candidate.state, driftDetected: drift.driftDetected, proposal: drift.proposedRollbackReceipt });
  }

  function rollback({ candidateId, promotionId, reason = 'drift' } = {}) {
    const candidate = candidates.get(candidateId);
    if (!candidate) return fail('unknown_candidate');
    if (![STATES.PROMOTED, STATES.ROLLBACK_PROPOSED].includes(candidate.state) || !text(promotionId)) {
      return fail('invalid_state', { state: candidate.state });
    }
    // Rolling back a version that is no longer bound would discard whatever replaced it.
    if (boundVersion(candidate) !== candidate.candidateVersion) return fail('not_bound');
    const admission = authorityFor(candidate, promotionId, 'rollback');
    if (!admission.ok || admission.admitted !== true) {
      record(candidate, 'rollback_refused', { code: admission.code });
      return fail(admission.code || 'rollback_not_admitted');
    }
    const rolled = trust.rollbackToPriorVersion({ workspaceId: candidate.workspaceId, capabilityId: candidate.capabilityId,
      targetProcedureVersion: candidate.priorVersion, admission, reason });
    if (!rolled.ok) return rolled;
    candidate.state = STATES.ROLLED_BACK;
    record(candidate, 'rolled_back', { admissionMode: admission.mode, reason });
    return Object.freeze({ ok: true, state: candidate.state, entry: rolled.entry });
  }

  function inspect(candidateId) {
    const candidate = candidates.get(candidateId);
    if (!candidate) return fail('unknown_candidate');
    const { trial, promotionBaseline, ...rest } = candidate;
    return Object.freeze({ ok: true, ...rest, trialStatus: trial ? trial.status : null,
      promotionBaseline: promotionBaseline ? Object.freeze({ ...promotionBaseline }) : null });
  }

  return Object.freeze({ propose, evaluateCanary, promote, observe, rollback, inspect,
    auditTrail: () => Object.freeze([...audit]) });
}

module.exports = Object.freeze({ createReflectivePromotion, ARTIFACT_TYPES, AUTHORITY_SURFACES, STATES });
