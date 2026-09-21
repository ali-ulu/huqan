'use strict';

/**
 * Experience — Capability Trust ladder (#2394, design #2383).
 *
 * Trust attaches to the Capability, not the Procedure. A Capability is a
 * named, workspace-scoped claim with a `boundProcedureVersion` pointer that
 * can change; the Procedure Registry (#2393) owns what that pointer means.
 * #2393 has not shipped in this branch, so `boundProcedureVersion` is
 * treated here as an opaque, caller-supplied string identifying one
 * procedure version — a `procedure.hash` from `compiler.js`, for example.
 * Nothing here interprets it beyond equality comparison.
 *
 * Sibling to `lib/trust-score-aggregator.js`, not a replacement: same
 * `insufficient-data` sentinel and minimum-evidence-count convention, a
 * different grain (per-capability vs per-workspace); this module does not
 * read from or write into that aggregator.
 *
 * Pure functional core plus a small in-memory registry, following the shape
 * of `createLearningPool()` in ./learning.js: caller-held, durable storage
 * is a separate concern left to whoever wires this in.
 *
 * ## Trust states
 *
 * `insufficient-data | probationary | trusted | demoted`. A caller must
 * read the explicit state, never a boolean — `insufficient-data` and
 * `demoted` must never be conflatable.
 *
 * ## State derivation
 *
 * On every recorded run the state is *recomputed from evidence*, not
 * incrementally patched — `trusted` requires zero negatives in the
 * trailing window, so one negative removes eligibility the instant it's
 * recorded, with no special case needed. Two actions sit outside the
 * formula on purpose:
 *
 * - **Procedure rebind** forces `probationary` regardless of prior state,
 *   even with zero evidence for the new version — the registry's `floor`
 *   field is why: once rebound at least once, "no evidence yet" reads as
 *   "not yet reproven," not "unknown." A never-rebound capability has no
 *   floor and starts at `insufficient-data`.
 * - **Operator/policy block** forces `demoted` unconditionally, immune to
 *   the evidence formula, until explicitly cleared.
 *
 * Evidence for a superseded procedure version is never deleted, only
 * excluded from the active window.
 *
 * `promoteCanaryCandidate`/`rollbackToPriorVersion`/`getEvidenceForVersion`/
 * `proposeDriftRollback` (#2397) and `incrementFallbackPreferredOverCount`
 * (design #2385) extend this same ladder via `rebindProcedure` above; both
 * live in sibling files for check:file-size budget reasons.
 */

const { createCanaryExtension } = require('./capability-trust-canary-extension');
const { createFallbackExtension } = require('./capability-trust-fallback-extension');

const TRUST_STATES = Object.freeze({
  INSUFFICIENT_DATA: 'insufficient-data',
  PROBATIONARY: 'probationary',
  TRUSTED: 'trusted',
  DEMOTED: 'demoted',
});

const CAPABILITY_TRUST_SCHEMA_VERSION = 'huqan-capability-trust-v1';

/**
 * Tunables (#2383's proposed defaults; named so a policy change is a
 * one-line diff with a visible reason, not a buried magic number).
 */
// Matches trust-score-aggregator.js's MIN_ACTIONS_FOR_SCORE: below this many
// runs against the bound procedure version, nothing is known yet.
const MIN_EXECUTIONS_FOR_TRUST = 10;
// >= this many verified positive_procedure runs, 0 negatives in the
// trailing window, promotes probationary -> trusted.
const MIN_TRUSTED_EXECUTIONS = 25;
// Trailing window bound A: at most this many recent runs.
const TRUSTED_WINDOW_RUNS = 50;
// Trailing window bound B: at most this many days back. The active window is
// whichever of the two bounds yields the SMALLER (more restrictive) set —
// see activeWindowEvents() below; this is a pragmatic reading of the design
// comment's "last 50 runs or 30 days, whichever is smaller," flagged in the
// implementation report as a resolved ambiguity, not a silent guess.
const TRUSTED_WINDOW_DAYS = 30;
// >= this many negative_example runs in the trailing window drops
// probationary -> demoted (trusted passes through probationary first).
const DEMOTION_NEGATIVE_THRESHOLD = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

const POSITIVE = 'positive_procedure';
const NEGATIVE = 'negative_example';

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function compositeKey(workspaceId, capabilityId) {
  return `${workspaceId}::${capabilityId}`;
}

/** The `insufficient-data` view returned for any capability never created. */
function unknownEntry(workspaceId, capabilityId, trustPolicyVersion) {
  return Object.freeze({
    capabilityId,
    workspaceId,
    boundProcedureVersion: null,
    trustState: TRUST_STATES.INSUFFICIENT_DATA,
    trustPolicyVersion: trustPolicyVersion || null,
    capabilityTrustSchemaVersion: CAPABILITY_TRUST_SCHEMA_VERSION,
    evidenceWindow: Object.freeze({
      procedureVersion: null, positiveCount: 0, negativeCount: 0, totalCount: 0,
      windowStart: null, windowEnd: null,
    }),
    history: Object.freeze([]),
    operatorBlocked: false,
    promotionReceipts: Object.freeze([]),
    // See incrementFallbackPreferredOverCount() below.
    fallbackPreferredOverCount: 0,
  });
}

/**
 * Events within the trailing window for the entry's currently-bound
 * procedure version, restricted to countable evidence
 * (`positive_procedure` / `negative_example`). Whichever of "last
 * TRUSTED_WINDOW_RUNS runs" or "last TRUSTED_WINDOW_DAYS days" is the
 * smaller set wins, per TRUSTED_WINDOW_DAYS's doc comment above.
 */
function activeWindowEvents(events, boundProcedureVersion, now) {
  const scoped = events.filter((e) => e.procedureVersion === boundProcedureVersion
    && (e.learningEligibility === POSITIVE || e.learningEligibility === NEGATIVE));
  const cutoff = now - TRUSTED_WINDOW_DAYS * DAY_MS;
  const withinDays = scoped.filter((e) => e.occurredAt >= cutoff);
  const withinRuns = scoped.slice(-TRUSTED_WINDOW_RUNS);
  return withinDays.length <= withinRuns.length ? withinDays : withinRuns;
}

/**
 * Pure state derivation from counted evidence. `floor` is `null` (fresh
 * capability, never rebound) or `TRUST_STATES.PROBATIONARY` (rebound at
 * least once): it only changes what "not enough evidence yet" reads as, it
 * never blocks trusted/demoted once the evidence formula reaches them.
 */
function deriveState({ totalForBoundVersion, windowPositive, windowNegative, operatorBlocked, floor }) {
  if (operatorBlocked) return TRUST_STATES.DEMOTED;
  if (windowNegative >= DEMOTION_NEGATIVE_THRESHOLD) return TRUST_STATES.DEMOTED;
  if (windowPositive >= MIN_TRUSTED_EXECUTIONS && windowNegative === 0) return TRUST_STATES.TRUSTED;
  if (totalForBoundVersion < MIN_EXECUTIONS_FOR_TRUST) {
    return floor === TRUST_STATES.PROBATIONARY ? TRUST_STATES.PROBATIONARY : TRUST_STATES.INSUFFICIENT_DATA;
  }
  return TRUST_STATES.PROBATIONARY;
}

function snapshotOf(record, now) {
  const window = activeWindowEvents(record.events, record.boundProcedureVersion, now);
  const positiveCount = window.filter((e) => e.learningEligibility === POSITIVE).length;
  const negativeCount = window.filter((e) => e.learningEligibility === NEGATIVE).length;
  const totalForBoundVersion = record.events.filter((e) => e.procedureVersion === record.boundProcedureVersion
    && (e.learningEligibility === POSITIVE || e.learningEligibility === NEGATIVE)).length;
  return {
    totalForBoundVersion,
    windowPositive: positiveCount,
    windowNegative: negativeCount,
    windowEvents: window,
  };
}

function toPublicEntry(record) {
  const window = record.lastWindow || [];
  const windowStart = window.length ? window[0].occurredAt : null;
  const windowEnd = window.length ? window[window.length - 1].occurredAt : null;
  return Object.freeze({
    capabilityId: record.capabilityId,
    workspaceId: record.workspaceId,
    boundProcedureVersion: record.boundProcedureVersion,
    trustState: record.trustState,
    trustPolicyVersion: record.trustPolicyVersion,
    capabilityTrustSchemaVersion: CAPABILITY_TRUST_SCHEMA_VERSION,
    evidenceWindow: Object.freeze({
      procedureVersion: record.boundProcedureVersion,
      positiveCount: record.lastPositive || 0,
      negativeCount: record.lastNegative || 0,
      totalCount: record.lastTotal || 0,
      windowStart,
      windowEnd,
    }),
    history: Object.freeze(record.history.slice()),
    operatorBlocked: record.operatorBlocked,
    promotionReceipts: Object.freeze((record.promotionReceipts || []).slice()),
    fallbackPreferredOverCount: record.fallbackPreferredOverCount || 0,
  });
}

/**
 * Create a capability trust registry. In-memory and caller-held, matching
 * ./learning.js and ./compiler.js: no storage backend is invented here.
 */
function createCapabilityTrustRegistry() {
  /** @type {Map<string, object>} */
  const records = new Map();

  function applyTransition(record, nextState, reason, atEventId, now) {
    if (nextState === record.trustState) return;
    record.history.push(Object.freeze({
      fromState: record.trustState,
      toState: nextState,
      atEventId: atEventId || null,
      reason,
      procedureVersionAtChange: record.boundProcedureVersion,
      at: now,
    }));
    record.trustState = nextState;
  }

  function recompute(record, now, reason, atEventId) {
    const snap = snapshotOf(record, now);
    record.lastWindow = snap.windowEvents;
    record.lastPositive = snap.windowPositive;
    record.lastNegative = snap.windowNegative;
    record.lastTotal = snap.totalForBoundVersion;
    const next = deriveState({
      totalForBoundVersion: snap.totalForBoundVersion,
      windowPositive: snap.windowPositive,
      windowNegative: snap.windowNegative,
      operatorBlocked: record.operatorBlocked,
      floor: record.floor,
    });
    applyTransition(record, next, reason, atEventId, now);
  }

  /**
   * Create a capability entry. Not transitive: `composedFrom` is recorded
   * for traceability only — the trust of any component capability is never
   * read, so composition always starts at `insufficient-data` (acceptance
   * test 7), full stop.
   */
  function createCapability({
    workspaceId, capabilityId, boundProcedureVersion, composedFrom = [], trustPolicyVersion = null,
  } = {}) {
    if (!nonEmptyString(workspaceId) || !nonEmptyString(capabilityId) || !nonEmptyString(boundProcedureVersion)) {
      return { ok: false, code: 'invalid_capability' };
    }
    const key = compositeKey(workspaceId, capabilityId);
    if (records.has(key)) return { ok: false, code: 'already_exists' };
    const record = {
      capabilityId,
      workspaceId,
      boundProcedureVersion,
      composedFrom: Array.isArray(composedFrom) ? composedFrom.slice() : [],
      trustState: TRUST_STATES.INSUFFICIENT_DATA,
      trustPolicyVersion,
      events: [],
      history: [],
      operatorBlocked: false,
      operatorBlock: null,
      floor: null,
      lastWindow: [], lastPositive: 0, lastNegative: 0, lastTotal: 0,
      promotionReceipts: [],
      fallbackPreferredOverCount: 0,
    };
    records.set(key, record);
    return { ok: true, entry: toPublicEntry(record) };
  }

  /**
   * Record one Experience run's evidence against a capability. Auto-creates
   * the entry at `insufficient-data` if it has never been created — a run
   * arriving for a capability nobody explicitly registered still has to be
   * counted, and starting it anywhere but `insufficient-data` would fabricate
   * history that was never observed.
   */
  function recordRun({
    workspaceId, capabilityId, eventId, runId, learningEligibility, procedureVersion,
    occurredAt = Date.now(), trustPolicyVersion = null,
  } = {}) {
    if (!nonEmptyString(workspaceId) || !nonEmptyString(capabilityId) || !nonEmptyString(procedureVersion)) {
      return { ok: false, code: 'invalid_run' };
    }
    const key = compositeKey(workspaceId, capabilityId);
    let record = records.get(key);
    if (!record) {
      createCapability({ workspaceId, capabilityId, boundProcedureVersion: procedureVersion, trustPolicyVersion });
      record = records.get(key);
    }
    if (trustPolicyVersion) record.trustPolicyVersion = trustPolicyVersion;
    record.events.push(Object.freeze({
      eventId: eventId || null,
      runId: runId || null,
      learningEligibility: learningEligibility || 'unknown',
      procedureVersion,
      occurredAt: Number.isFinite(occurredAt) ? occurredAt : Date.now(),
    }));
    const reason = learningEligibility === NEGATIVE ? 'negative_example_recorded'
      : learningEligibility === POSITIVE ? 'positive_procedure_recorded'
        : 'run_recorded';
    recompute(record, record.events[record.events.length - 1].occurredAt, reason, eventId);
    return { ok: true, entry: toPublicEntry(record) };
  }

  /**
   * Procedure rebind: force `probationary` regardless of prior state. Old
   * evidence is retained (still in `record.events`, version-labeled) and
   * simply falls outside the active window because the window is scoped to
   * `boundProcedureVersion`.
   */
  function rebindProcedure({
    workspaceId, capabilityId, newProcedureVersion, reason = 'procedure_rebind', atEventId, at = Date.now(),
  } = {}) {
    const record = records.get(compositeKey(workspaceId, capabilityId));
    if (!record) return { ok: false, code: 'not_found' };
    if (!nonEmptyString(newProcedureVersion)) return { ok: false, code: 'invalid_procedure_version' };
    record.boundProcedureVersion = newProcedureVersion;
    record.floor = TRUST_STATES.PROBATIONARY;
    // Force the transition explicitly (bypassing the evidence formula, which
    // would read zero evidence for the new version as insufficient-data)
    // then let the formula take back over for anything the floor doesn't
    // already guarantee (e.g. an operator block still wins).
    applyTransition(record, TRUST_STATES.PROBATIONARY, reason, atEventId, at);
    recompute(record, at, reason, atEventId);
    return { ok: true, entry: toPublicEntry(record) };
  }

  /**
   * Operator/policy block: force `demoted`, record identity + reason, and
   * stay there — immune to the evidence formula — until cleared.
   */
  function applyOperatorBlock({
    workspaceId, capabilityId, operatorId, reason, atEventId, at = Date.now(),
  } = {}) {
    const record = records.get(compositeKey(workspaceId, capabilityId));
    if (!record) return { ok: false, code: 'not_found' };
    if (!nonEmptyString(operatorId) || !nonEmptyString(reason)) {
      return { ok: false, code: 'invalid_operator_block' };
    }
    record.operatorBlocked = true;
    record.operatorBlock = Object.freeze({ operatorId, reason, at });
    applyTransition(record, TRUST_STATES.DEMOTED, `operator_block:${reason}`, atEventId, at);
    return { ok: true, entry: toPublicEntry(record) };
  }

  /**
   * Clear an operator block. The capability re-enters ordinary evidence
   * evaluation; it does not auto-promote back to `trusted` on the strength
   * of pre-block evidence alone (the block itself is now a `probationary`
   * floor event, same treatment as a rebind) — clearing is not a pardon that
   * erases the fact that the capability was blocked.
   */
  function clearOperatorBlock({
    workspaceId, capabilityId, operatorId, reason = 'operator_block_cleared', atEventId, at = Date.now(),
  } = {}) {
    const record = records.get(compositeKey(workspaceId, capabilityId));
    if (!record) return { ok: false, code: 'not_found' };
    if (!nonEmptyString(operatorId)) return { ok: false, code: 'invalid_operator' };
    record.operatorBlocked = false;
    record.operatorBlock = null;
    record.floor = TRUST_STATES.PROBATIONARY;
    recompute(record, at, `operator_unblock:${reason}`, atEventId);
    return { ok: true, entry: toPublicEntry(record) };
  }

  /** Workspace-scoped read. A capabilityId in a different workspace is a
   * different entry entirely — no cross-workspace lookup exists. */
  function get(workspaceId, capabilityId) {
    const record = records.get(compositeKey(workspaceId, capabilityId));
    return record ? toPublicEntry(record) : unknownEntry(workspaceId, capabilityId, null);
  }

  const canaryExt = createCanaryExtension({
    records, compositeKey, nonEmptyString, rebindProcedure, toPublicEntry,
  });
  const fallbackExt = createFallbackExtension({ records, compositeKey, toPublicEntry });

  return Object.freeze({
    createCapability,
    recordRun,
    rebindProcedure,
    applyOperatorBlock,
    clearOperatorBlock,
    get,
    ...canaryExt,
    ...fallbackExt,
  });
}

module.exports = Object.freeze({
  TRUST_STATES,
  CAPABILITY_TRUST_SCHEMA_VERSION,
  MIN_EXECUTIONS_FOR_TRUST,
  MIN_TRUSTED_EXECUTIONS,
  TRUSTED_WINDOW_RUNS,
  TRUSTED_WINDOW_DAYS,
  DEMOTION_NEGATIVE_THRESHOLD,
  createCapabilityTrustRegistry,
  deriveState,
});
