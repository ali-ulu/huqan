'use strict';

// AURA <-> canary bridge.
//
// Two things the AURA loop needs from HUQAN's own canary machinery, so the loop
// stops being *more* aggressive than the core it plugs into:
//
//   1. A rule learned from an AURA signal must not go straight to `active`.
//      HUQAN already refuses to promote a freshly-compiled candidate procedure
//      without a bounded canary trial (lib/experience/canary.js, #2397): same
//      distribution as baseline, cost AND negative-example rate at least as
//      good, a strict improvement somewhere, capped at maxRuns/maxDays and
//      failing closed when the cap is hit without enough evidence. This bridge
//      routes the AURA-learned rule through exactly that trial, so the loop
//      inherits the core's caution instead of bypassing it.
//
//   2. AURA's social-risk verdict is a probability; a planted context canary
//      turns it into a *deterministic* leak signal. AURA flags the intent, the
//      canary proves the act: if the marker planted where the risky text is
//      heading shows up in an outbound payload, AB14 blocks and the receipt
//      carries a fingerprint (lib/context-canary.js). The blocked leak is then
//      the strongest possible answer to AURA's open cross-check.
//
// Pure and injectable: no I/O, no clock beyond the caller's, no model call. The
// loop supplies the runs; this module supplies the AURA-shaped framing and the
// promotion/admission discipline.

const {
  CANARY_STATUS,
  DEFAULT_CANARY_MAX_DAYS,
  DEFAULT_CANARY_MAX_RUNS,
  DEFAULT_CANARY_SAMPLE_EVERY_NTH,
  evaluateCanaryTrial,
  shouldRouteToCandidate,
} = require('./experience/canary');
const {
  evaluateContextCanaries,
  issueContextCanary,
} = require('./context-canary');

const AURA_CANARY_BRIDGE_VERSION = 'aura-canary-bridge.v1';

// The request shape a router matches against: the operation axis plus the AURA
// signals present. Two AURA calls are the same shape when they share the
// operation and at least one signal, which is what keeps a candidate sample
// comparable to the baseline window (evaluateCanaryTrial refuses disjoint
// samples rather than scoring them).
function auraRuleDeclared({ operation, signalIds } = {}) {
  return Object.freeze({
    operation: String(operation || '').trim(),
    signals: [...(Array.isArray(signalIds) ? signalIds : [])].map(String).sort(),
  });
}

// A single trial run. `learningEligibility` is `positive_procedure` when the
// outcome was right and `negative_example` when the operator judged it wrong;
// the trial compares the two rates, so a rule that trades more correct escalations
// for a few more false escalations still has to clear the baseline to promote.
function makeRun({
  occurredAt, declared, learningEligibility, executionCost = 1, verificationCost = 0, canaryOverheadCost = 0,
} = {}) {
  return Object.freeze({
    occurredAt,
    declared,
    learningEligibility,
    executionCost,
    verificationCost,
    canaryOverheadCost,
  });
}

// Evaluate the AURA-learned rule as a canary candidate against the baseline
// window. Defaults are the core trial's, so a policy change stays a one-line
// diff in lib/experience/canary.js and both callers move together.
function evaluateAuraRuleTrial({
  candidateRuns,
  baselineWindowRuns,
  maxRuns = DEFAULT_CANARY_MAX_RUNS,
  maxDays = DEFAULT_CANARY_MAX_DAYS,
  startAt,
  now = Date.now(),
} = {}) {
  return evaluateCanaryTrial({
    candidateRuns, baselineWindowRuns, maxRuns, maxDays, startAt, now,
  });
}

// The promotion gate. A rule may only be activated when the trial has *passed*
// AND an admission exists (an explicit, single-use approval — a learner never
// authorizes its own change, see lib/experience/canary-admission.js). Anything
// else leaves the rule un-activated: in trial, failed, or refused all mean
// "not yet", never "assume it is fine".
function promotionDecision({ trial, hasAdmission = false } = {}) {
  const status = trial && trial.status;
  const activate = trial && trial.ok === true && status === CANARY_STATUS.PASSED && hasAdmission === true;
  let reason;
  if (!trial || trial.ok !== true) reason = (trial && trial.code) || 'trial_unavailable';
  else if (status !== CANARY_STATUS.PASSED) reason = status === CANARY_STATUS.IN_TRIAL ? 'trial_in_progress' : 'trial_not_passed';
  else if (hasAdmission !== true) reason = 'no_admission';
  else reason = 'cleared_baseline';
  return Object.freeze({ activate, status: status || 'unknown', reason });
}

// Plant a canary in the context AURA's risky text is trying to reach. The marker
// is bound to the AURA signals that justified planting it, so a trip later reads
// back as "the context behind these signals leaked".
function plantCanaryForAuraSignal({ signalIds, context = '' } = {}) {
  const canary = issueContextCanary();
  return Object.freeze({
    bridgeVersion: AURA_CANARY_BRIDGE_VERSION,
    canaryId: canary.canaryId,
    marker: canary.marker,
    fingerprint: canary.fingerprint,
    signalIds: [...(Array.isArray(signalIds) ? signalIds : [])].map(String).sort(),
    context: String(context || ''),
  });
}

// Scan an outbound payload for any planted canary. Delegates to the core
// tripwire (AB14) so detection, encodings and fingerprinting never fork.
function detectCanaryLeak(payload) {
  return evaluateContextCanaries(payload);
}

module.exports = {
  AURA_CANARY_BRIDGE_VERSION,
  CANARY_STATUS,
  DEFAULT_CANARY_SAMPLE_EVERY_NTH,
  auraRuleDeclared,
  detectCanaryLeak,
  evaluateAuraRuleTrial,
  makeRun,
  plantCanaryForAuraSignal,
  promotionDecision,
  shouldRouteToCandidate,
};
