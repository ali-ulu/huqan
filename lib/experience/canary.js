'use strict';

/**
 * Experience — Canary trial state machine (design comment on #2397, R3
 * Phase 9; extends #2394's ladder, does not fork it).
 *
 * Canary sits between a freshly-compiled candidate procedure and
 * eligibility for #2394's existing promotion evaluation. Pure and
 * hermetic (no I/O, no storage, no model call, no journal/registry
 * import). Three responsibilities:
 *
 * - `totalCost = executionCost + verificationCost + (candidateOnly ?
 *   canaryOverheadCost : 0)`. A candidate is never compared on execution
 *   time alone while its verification is more expensive.
 * - Same-distribution sampling: a comparison between a candidate's canary
 *   sample and baseline's comparison window is refused (`ok: false`),
 *   never silently scored, when the two don't overlap on request shape —
 *   checked via `router.js`'s `structuralMatch`, reused verbatim.
 * - Bounded pass/fail: `totalCost` AND `negative_example` rate must both
 *   be at least as good as baseline, and a tie on both does not pass —
 *   clear baseline, don't merely match it (#2394's own asymmetry). Capped
 *   at `DEFAULT_CANARY_MAX_RUNS`/`DEFAULT_CANARY_MAX_DAYS`, whichever
 *   first; hitting the cap without enough evidence fails closed.
 *
 * Does NOT: import `capability-trust.js` (the dependency runs the other
 * way — its extension imports this module). Does NOT route a real
 * request; `shouldRouteToCandidate()` is a pure decision the caller's
 * dispatcher consults per request. Does NOT auto-promote or auto-revert:
 * `resolveAdmission()` only reports whether an admission record already
 * exists, mirroring `lib/human-approval-toggle.js` — no explicit approval
 * and no active toggle means no promotion.
 */

const crypto = require('node:crypto');
const { structuralMatch } = require('./router');

const CANARY_SCHEMA_VERSION = 'huqan-canary-v1';

const DAY_MS = 24 * 60 * 60 * 1000;

// Bounded trial tunables, named so a policy change is a one-line diff with
// a visible reason (same discipline as capability-trust.js's constants).
// Trial stops at whichever of these two bounds is hit first.
const DEFAULT_CANARY_MAX_RUNS = 200;
const DEFAULT_CANARY_MAX_DAYS = 14;
// Below this many canary-sample runs, the trial has not produced enough
// evidence to decide pass/fail yet — mirrors capability-trust's
// MIN_EXECUTIONS_FOR_TRUST floor so a hypothesis/decision never fires on
// noise from a tiny sample.
const MIN_CANARY_SAMPLE_SIZE = 10;
// Every Nth matching live request is diverted to the candidate during
// trial; the remainder continue to baseline. This is what keeps candidate
// and baseline runs interleaved on the same underlying request stream
// instead of the candidate being tested on a cherry-picked slice.
const DEFAULT_CANARY_SAMPLE_EVERY_NTH = 5;

const CANARY_STATUS = Object.freeze({
  IN_TRIAL: 'in_trial',
  PASSED: 'passed',
  FAILED: 'failed',
});

const POSITIVE = 'positive_procedure';
const NEGATIVE = 'negative_example';

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
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

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * `totalCost = executionCost + verificationCost + (candidateOnly ?
 * canaryOverheadCost : 0)`. `canaryOverheadCost` only applies while a
 * candidate is still on trial (`candidateOnly: true`) so it is never
 * double-counted into a steady-state (post-promotion) comparison.
 * Malformed/negative inputs are refused rather than coerced to 0, which
 * would silently understate a candidate's true cost.
 */
function computeTotalCost({
  executionCost, verificationCost, candidateOnly = false, canaryOverheadCost = 0,
} = {}) {
  if (!finiteNonNegative(executionCost) || !finiteNonNegative(verificationCost)
    || !finiteNonNegative(canaryOverheadCost)) {
    return { ok: false, code: 'invalid_cost_inputs' };
  }
  const totalCost = executionCost + verificationCost + (candidateOnly ? canaryOverheadCost : 0);
  return { ok: true, totalCost };
}

/**
 * Two requests "overlap in shape" when either's declared fields
 * structurally match the other's — the exact vocabulary `router.js` uses
 * to decide whether a capability's preconditions are satisfied by a
 * request, reused verbatim (not re-derived) rather than an approximate
 * "similar enough" notion.
 */
function requestsOverlapInShape(declaredA, declaredB) {
  return structuralMatch(declaredA, declaredB) || structuralMatch(declaredB, declaredA);
}

/**
 * Whether ANY candidate-sample request overlaps in shape with ANY
 * baseline-comparison-window request. `false` means the two samples were
 * drawn from disjoint request shapes and a comparison between them must be
 * refused, not scored.
 */
function comparisonOverlaps(candidateRequests, baselineRequests) {
  const candidates = Array.isArray(candidateRequests) ? candidateRequests : [];
  const baseline = Array.isArray(baselineRequests) ? baselineRequests : [];
  return candidates.some((c) => baseline.some((b) => requestsOverlapInShape(c, b)));
}

/**
 * Truncate a time-ordered candidate run list to the bounded trial window:
 * at most `maxRuns` entries, and none beyond `maxDays` from `startAt` —
 * "whichever comes first" falls out of applying both bounds together.
 */
function boundedTrialRuns(candidateRuns, {
  maxRuns = DEFAULT_CANARY_MAX_RUNS, maxDays = DEFAULT_CANARY_MAX_DAYS, startAt,
} = {}) {
  const runs = Array.isArray(candidateRuns) ? candidateRuns : [];
  if (!Number.isFinite(startAt)) return runs.slice(0, maxRuns);
  const cutoff = startAt + maxDays * DAY_MS;
  return runs.filter((r) => Number.isFinite(r.occurredAt) && r.occurredAt <= cutoff).slice(0, maxRuns);
}

/** Whether the bounded trial's caps have been exhausted: either the run
 * count cap was hit, or `now` is past the day cap from `startAt`. */
function isCapReached(candidateRuns, boundedRuns, { maxRuns, maxDays, startAt, now }) {
  const runs = Array.isArray(candidateRuns) ? candidateRuns : [];
  if (boundedRuns.length >= maxRuns) return true;
  if (Number.isFinite(startAt) && Number.isFinite(now) && now >= startAt + maxDays * DAY_MS) return true;
  return boundedRuns.length < runs.length;
}

function countAndAggregate(runs, { candidateOnly }) {
  let totalCost = 0;
  let positive = 0;
  let negative = 0;
  for (const run of runs) {
    if (run.learningEligibility !== POSITIVE && run.learningEligibility !== NEGATIVE) continue;
    const cost = computeTotalCost({
      executionCost: run.executionCost,
      verificationCost: run.verificationCost,
      candidateOnly,
      canaryOverheadCost: run.canaryOverheadCost,
    });
    if (!cost.ok) return null;
    totalCost += cost.totalCost;
    if (run.learningEligibility === POSITIVE) positive += 1;
    else negative += 1;
  }
  const total = positive + negative;
  return {
    totalCost, positiveCount: positive, negativeCount: negative, totalCount: total,
    negativeRate: total > 0 ? negative / total : null,
  };
}

/**
 * Evaluate a bounded canary trial: candidate runs vs. baseline's
 * comparison-window runs. Each run: `{ occurredAt, declared,
 * learningEligibility, executionCost, verificationCost, canaryOverheadCost }`.
 * `declared` is the request's declared fields (the same shape `router.js`
 * matches against preconditions).
 *
 * Returns `{ ok: false, code: 'comparison_refused_no_shape_overlap' }` when
 * the samples don't overlap — refused, never silently scored (acceptance
 * test 3). Otherwise `{ ok: true, status, ... }` where `status` is
 * `in_trial` (not enough evidence yet, cap not reached), `passed`, or
 * `failed` (including "cap reached without enough evidence to decide" —
 * fails closed rather than passing on an unproven candidate).
 */
function evaluateCanaryTrial({
  candidateRuns, baselineWindowRuns, maxRuns = DEFAULT_CANARY_MAX_RUNS,
  maxDays = DEFAULT_CANARY_MAX_DAYS, minSampleSize = MIN_CANARY_SAMPLE_SIZE,
  startAt, now = Date.now(),
} = {}) {
  const rawCandidateRuns = Array.isArray(candidateRuns) ? candidateRuns : [];
  const baseline = Array.isArray(baselineWindowRuns) ? baselineWindowRuns : [];
  const bounded = boundedTrialRuns(rawCandidateRuns, { maxRuns, maxDays, startAt });
  const capReached = isCapReached(rawCandidateRuns, bounded, { maxRuns, maxDays, startAt, now });

  const candidateDeclared = bounded.map((r) => r.declared).filter(isRecord);
  const baselineDeclared = baseline.map((r) => r.declared).filter(isRecord);
  if (candidateDeclared.length > 0 && baselineDeclared.length > 0
    && !comparisonOverlaps(candidateDeclared, baselineDeclared)) {
    return { ok: false, code: 'comparison_refused_no_shape_overlap' };
  }

  const candidateMetrics = countAndAggregate(bounded, { candidateOnly: true });
  const baselineMetrics = countAndAggregate(baseline, { candidateOnly: false });
  if (!candidateMetrics || !baselineMetrics) return { ok: false, code: 'invalid_cost_inputs' };

  if (candidateMetrics.totalCount < minSampleSize || baselineMetrics.totalCount < minSampleSize) {
    if (!capReached) {
      return {
        ok: true, status: CANARY_STATUS.IN_TRIAL, capReached, sampleSize: candidateMetrics.totalCount,
        minSampleSize, candidateMetrics, baselineMetrics, reason: 'insufficient_sample',
      };
    }
    return {
      ok: true, status: CANARY_STATUS.FAILED, capReached, sampleSize: candidateMetrics.totalCount,
      minSampleSize, candidateMetrics, baselineMetrics, reason: 'cap_reached_insufficient_sample',
    };
  }

  // Both dimensions must be at least as good as baseline; a tie on both
  // does not promote (candidate must clear baseline, not merely match it).
  const costAtLeastAsGood = candidateMetrics.totalCost <= baselineMetrics.totalCost;
  const negRateAtLeastAsGood = candidateMetrics.negativeRate <= baselineMetrics.negativeRate;
  const strictlyBetterSomewhere = candidateMetrics.totalCost < baselineMetrics.totalCost
    || candidateMetrics.negativeRate < baselineMetrics.negativeRate;
  const passed = costAtLeastAsGood && negRateAtLeastAsGood && strictlyBetterSomewhere;

  return {
    ok: true,
    status: passed ? CANARY_STATUS.PASSED : CANARY_STATUS.FAILED,
    capReached,
    sampleSize: candidateMetrics.totalCount,
    minSampleSize,
    candidateMetrics,
    baselineMetrics,
    reason: passed ? 'cleared_baseline' : 'did_not_clear_baseline',
  };
}

/**
 * Per-request sampling decision for a live request: whether THIS request
 * (identified by its 1-based sequence number within the matching stream)
 * should be diverted to the candidate. `status` must be exactly
 * `'in_trial'` — a `'failed'` (or `'passed'`, or `'refused'`) canary never
 * routes a production request outside its capped sample; the status check
 * is deliberately the first, unconditional guard so nothing downstream can
 * reorder it away (acceptance test 4: mutation-test this directly).
 */
function shouldRouteToCandidate({
  status, requestSequenceNumber, sampleEveryNth = DEFAULT_CANARY_SAMPLE_EVERY_NTH, capReached = false,
} = {}) {
  if (status !== CANARY_STATUS.IN_TRIAL) return false;
  if (capReached) return false;
  if (!Number.isInteger(requestSequenceNumber) || requestSequenceNumber < 1) return false;
  if (!Number.isInteger(sampleEveryNth) || sampleEveryNth < 1) return false;
  return requestSequenceNumber % sampleEveryNth === 0;
}

// ─── Promotion / rollback admission (mirrors lib/human-approval-toggle.js's
// pattern: an explicit approval, or a standing receipted toggle — never a
// silent default) ────────────────────────────────────────────────────────

function compositeKey(workspaceId, capabilityId) {
  return `${workspaceId}::${capabilityId}`;
}

function receiptId(prefix, payload) {
  return `${prefix}_${sha256(stableKey(payload)).slice(0, 16)}`;
}

/**
 * Per-capability admission registry: a standing "auto-promote candidates
 * that clear canary" toggle (admin-only by convention — this module trusts
 * the caller's own authz to have verified `adminId` is an admin, the same
 * way `applyOperatorBlock` trusts its caller for `operatorId`), or a
 * one-time explicit approval consumed by the promotion/rollback it names.
 * Every resolution that admits a promotion — toggle-driven or explicit —
 * produces its own fresh receipt for that promotion event; "auto" changes
 * who approves, never whether an approval record exists.
 */
function createPromotionAdmissionRegistry() {
  /** @type {Map<string, { enabled: boolean, adminId: string, reason: string, at: number, receiptId: string }>} */
  const toggles = new Map();
  /** @type {Map<string, { approverId: string, reason: string, at: number, receiptId: string }>} */
  const explicitApprovals = new Map();

  function setAutoPromoteToggle({
    workspaceId, capabilityId, adminId, enabled, reason = 'admin_toggle', at = Date.now(),
  } = {}) {
    if (!nonEmptyString(workspaceId) || !nonEmptyString(capabilityId) || !nonEmptyString(adminId)) {
      return { ok: false, code: 'invalid_toggle_request' };
    }
    const key = compositeKey(workspaceId, capabilityId);
    const record = {
      enabled: enabled === true,
      adminId,
      reason,
      at,
      receiptId: receiptId('canary_toggle', { workspaceId, capabilityId, adminId, enabled: enabled === true, at }),
    };
    toggles.set(key, record);
    return { ok: true, receipt: Object.freeze({ ...record, workspaceId, capabilityId }) };
  }

  function getToggle(workspaceId, capabilityId) {
    return toggles.get(compositeKey(workspaceId, capabilityId)) || null;
  }

  /** Records a one-time explicit approval for exactly one promotion/rollback
   * event, named by `promotionId`. Consumed (removed) the moment
   * `resolveAdmission` uses it, so it cannot be silently replayed for a
   * later, different promotion. */
  function recordExplicitApproval({
    workspaceId, capabilityId, promotionId, approverId, reason = 'explicit_approval', at = Date.now(),
  } = {}) {
    if (!nonEmptyString(workspaceId) || !nonEmptyString(capabilityId)
      || !nonEmptyString(promotionId) || !nonEmptyString(approverId)) {
      return { ok: false, code: 'invalid_approval_request' };
    }
    const key = `${compositeKey(workspaceId, capabilityId)}::${promotionId}`;
    const record = {
      approverId,
      reason,
      at,
      receiptId: receiptId('canary_approval', { workspaceId, capabilityId, promotionId, approverId, at }),
    };
    explicitApprovals.set(key, record);
    return { ok: true, receipt: Object.freeze({ ...record, workspaceId, capabilityId, promotionId }) };
  }

  /**
   * Resolve whether a promotion/rollback named `promotionId` is admitted.
   * `admitted: false` (with no receipt) is the fail-closed default — this
   * is the codepath acceptance test 5 exercises: no explicit approval and
   * no active toggle means no promotion event may occur.
   */
  function resolveAdmission({ workspaceId, capabilityId, promotionId } = {}) {
    if (!nonEmptyString(workspaceId) || !nonEmptyString(capabilityId) || !nonEmptyString(promotionId)) {
      return { ok: false, code: 'invalid_admission_request' };
    }
    const approvalKey = `${compositeKey(workspaceId, capabilityId)}::${promotionId}`;
    const approval = explicitApprovals.get(approvalKey);
    if (approval) {
      explicitApprovals.delete(approvalKey);
      return {
        ok: true, admitted: true, mode: 'explicit_approval',
        receipt: Object.freeze({ ...approval, workspaceId, capabilityId, promotionId }),
      };
    }
    const toggle = getToggle(workspaceId, capabilityId);
    if (toggle && toggle.enabled) {
      // Fresh receipt for THIS promotion event, referencing the standing
      // toggle's own receipt — the toggle authorizes the mode, it is not
      // itself the promotion's receipt.
      const promotionReceipt = {
        receiptId: receiptId('canary_auto_promotion', { workspaceId, capabilityId, promotionId, at: Date.now() }),
        toggleReceiptId: toggle.receiptId,
        adminId: toggle.adminId,
        at: Date.now(),
      };
      return {
        ok: true, admitted: true, mode: 'auto_promote_toggle',
        receipt: Object.freeze({ ...promotionReceipt, workspaceId, capabilityId, promotionId }),
      };
    }
    return { ok: true, admitted: false, code: 'no_admission_record' };
  }

  return Object.freeze({ setAutoPromoteToggle, recordExplicitApproval, resolveAdmission, getToggle });
}

module.exports = Object.freeze({
  CANARY_STATUS,
  DEFAULT_CANARY_MAX_RUNS,
  DEFAULT_CANARY_MAX_DAYS,
  DEFAULT_CANARY_SAMPLE_EVERY_NTH,
  MIN_CANARY_SAMPLE_SIZE,
  computeTotalCost,
  requestsOverlapInShape,
  comparisonOverlaps,
  boundedTrialRuns,
  evaluateCanaryTrial,
  shouldRouteToCandidate,
  createPromotionAdmissionRegistry,
});
