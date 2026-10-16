'use strict';

/**
 * Memory recall gate — the read-side mirror of lib/memory-admission-gate.js.
 *
 * The admission gate decides what is allowed to *become* memory. Nothing so far
 * decides what is allowed to come *back out* of it and spend tokens in a
 * context window. `lib/memory-query-engine.js` filters on workspace, status,
 * kind, actor, dates, content and metadata — none of which asks whether a
 * record is still authoritative.
 *
 * This module asks that question and nothing else. Given records the query
 * engine already selected, it returns a per-record verdict:
 *
 *   admit    - current, provenanced, active; safe to spend context on
 *   degrade  - still readable, no longer provably authoritative; the caller
 *              should summarize or annotate rather than quote it as governing
 *   withhold - must not enter the context window at all
 *
 * ## Two deliberate constraints
 *
 * 1. **It reports; it does not write.** Withheld and degraded records produce
 *    `ledgerEvents` for the caller to append through the existing audit path.
 *    The gate never appends them itself: an enforcer that also authors the only
 *    account of its own decisions cannot be audited. Enforcement and witness
 *    stay in different layers, exactly as they do on the write side.
 *
 * 2. **`degrade` is not `false`.** A stale record may be perfectly accurate.
 *    Degrading it is a statement about what the system can still *establish*,
 *    not about whether the content is true. Only unprovenanced, inactive,
 *    cross-workspace or malformed records are withheld outright.
 *
 * When the caller cannot supply the current trust policy version, the gate
 * reports `POLICY_VERSION_UNKNOWN` and makes no staleness claim, rather than
 * fabricating one — the same honesty rule `lib/trust-score-aggregator.js`
 * applies with `insufficient-data`.
 *
 * Deliberately NOT done here: token accounting, re-verification of receipt
 * chains, and any I/O. All three belong to callers that have the budget, the
 * chain and the store; this module is a pure transform over records it is
 * handed and must never mutate them.
 *
 * Self-contamination screening (#3464, R09) is an opt-in signal on top of the
 * verdicts above. When the caller supplies `decontamination.corpus` — source
 * texts or training material the recall must not echo — each record's content
 * is scored with lib/memory-decontamination.js and a record at or above the
 * threshold is withheld as `self_contamination`: a leaked record never reaches
 * the context window, so it cannot be re-learned and promoted. The score is
 * measured on every evaluated record while the option is on, so the loop is
 * observable, not just cut.
 */

const { isPlainObject } = require('./is-plain-object');
const {
  MEMORY_DECONTAMINATION_VERSION,
  evaluateDecontamination,
  projectContentText,
} = require('./memory-decontamination');

const MEMORY_RECALL_DECISIONS = Object.freeze(['admit', 'degrade', 'withhold']);
const MEMORY_RECALL_POLICY_VERSION = 'huqan-memory-recall-v0.1.0';
const DECISION_SEVERITY = Object.freeze({ admit: 0, degrade: 1, withhold: 2 });
const ACTIVE_STATUSES = Object.freeze(['active']);
const LEDGER_EVENT_TYPES = Object.freeze({
  degrade: 'memory_recall_degraded',
  withhold: 'memory_recall_withheld',
});

function trimText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function failure(errors) {
  return {
    ok: false,
    type: 'memory-recall-decision',
    policyVersion: MEMORY_RECALL_POLICY_VERSION,
    workspaceId: '',
    decisions: [],
    admitted: [],
    degraded: [],
    withheld: [],
    ledgerEvents: [],
    summary: { considered: 0, admitted: 0, degraded: 0, withheld: 0 },
    warnings: [],
    errors,
  };
}

/**
 * Read a record's shelf life. `metadata.expiresAt` is where the admission
 * receipt puts a caller-*declared* expiry (#2017); a top-level `expiresAt` is
 * honoured too so a caller can hand the gate a projection rather than the
 * stored record. Absent a declaration, `metadata.reverificationHorizon` is
 * the admission gate's own *computed* horizon (#2795,
 * lib/admission-horizon.js) -- a declared expiry always wins when both are
 * present, since a caller's own claim about a fact's shelf life is more
 * specific than a risk-derived default.
 *
 * An expiry that cannot be parsed is reported as declared-but-unreadable
 * rather than quietly treated as "no expiry".
 */
function expiryOf(record) {
  const declaredRaw = trimText(record.expiresAt)
    || (isPlainObject(record.metadata) ? trimText(record.metadata.expiresAt) : '');
  const raw = declaredRaw
    || (isPlainObject(record.metadata) ? trimText(record.metadata.reverificationHorizon) : '');
  if (!raw) return { declared: false, parseable: false, at: 0 };
  const at = Date.parse(raw);
  return { declared: true, parseable: !Number.isNaN(at), at };
}

/**
 * Deterministic text projection of a record for decontamination scoring.
 * Non-content records (malformed entries) project to '' and score 0.
 */
function recordTextForDecontamination(record) {
  if (!isPlainObject(record)) return '';
  return projectContentText(record.content);
}

function signalsFor(record, context) {
  const signals = [];

  if (!isPlainObject(record)) {
    return { signals: [{ decision: 'withhold', reason: 'malformed_record' }], measurement: null };
  }
  if (trimText(record.workspaceId) !== context.workspaceId) {
    signals.push({ decision: 'withhold', reason: 'workspace_mismatch' });
  }
  if (!isPlainObject(record.provenance) || !trimText(record.provenance.provenanceId)) {
    signals.push({ decision: 'withhold', reason: 'missing_provenance' });
  }
  if (record.status !== undefined && !ACTIVE_STATUSES.includes(trimText(record.status))) {
    signals.push({ decision: 'withhold', reason: 'inactive_record' });
  }
  if (context.currentTrustPolicyVersion
      && trimText(record.trustPolicyVersion) !== context.currentTrustPolicyVersion) {
    signals.push({ decision: 'degrade', reason: 'stale_trust_policy' });
  }
  // An expiry the writer declared at admission. Degrade rather than withhold:
  // "stop relying on this after T" is a statement about authority, not about
  // truth, and a degraded record stays explainable where a withheld one is
  // silently simply absent. Placed after staleness so that when both fire the
  // more specific reason is the one reported.
  const expiry = expiryOf(record);
  if (expiry.declared && !expiry.parseable) {
    signals.push({ decision: 'degrade', reason: 'unparseable_expiry' });
  } else if (expiry.parseable && expiry.at <= context.observedAtMs) {
    signals.push({ decision: 'degrade', reason: 'expired_record' });
  }
  if (context.minConfidence !== null && isPlainObject(record.provenance)) {
    const confidence = Number(record.provenance.confidence);
    if (Number.isFinite(confidence) && confidence < context.minConfidence) {
      signals.push({ decision: 'degrade', reason: 'low_confidence' });
    }
  }

  if (context.decontamination) {
    const scored = evaluateDecontamination({
      text: recordTextForDecontamination(record),
      corpus: context.decontamination.corpus,
      threshold: context.decontamination.threshold,
      ngramSize: context.decontamination.ngramSize,
    });
    // Validation already passed at the gate boundary, so this is infallible
    // in practice; if it ever fails, fail closed on this record rather than
    // silently skipping the contamination screen.
    if (!scored.ok) {
      signals.push({ decision: 'withhold', reason: 'decontamination_error' });
      return { signals, measurement: null };
    }
    const measurement = {
      version: MEMORY_DECONTAMINATION_VERSION,
      score: scored.score,
      matchedNgrams: scored.matchedNgrams,
      totalNgrams: scored.totalNgrams,
      threshold: scored.threshold,
      contaminated: scored.contaminated,
    };
    if (scored.contaminated) {
      signals.push({
        decision: 'withhold',
        reason: 'self_contamination',
        score: scored.score,
        matchedNgrams: scored.matchedNgrams,
        totalNgrams: scored.totalNgrams,
        threshold: scored.threshold,
      });
    }
    if (signals.length === 0) signals.push({ decision: 'admit', reason: 'current_and_provenanced' });
    return { signals, measurement };
  }

  if (signals.length === 0) signals.push({ decision: 'admit', reason: 'current_and_provenanced' });
  return { signals, measurement: null };
}

function strictestOf(signals) {
  return signals.reduce((current, candidate) => (
    DECISION_SEVERITY[candidate.decision] >= DECISION_SEVERITY[current.decision] ? candidate : current
  ));
}

function ledgerEventFor(verdict, record, context, measurement = null) {
  const event = {
    eventType: LEDGER_EVENT_TYPES[verdict.decision],
    memoryId: verdict.memoryId,
    workspaceId: context.workspaceId,
    decision: verdict.decision,
    reason: verdict.reason,
    signals: verdict.signals.map((signal) => signal.reason),
    policyVersion: MEMORY_RECALL_POLICY_VERSION,
    recordedTrustPolicyVersion: isPlainObject(record) ? trimText(record.trustPolicyVersion) : '',
    currentTrustPolicyVersion: context.currentTrustPolicyVersion,
    observedAt: context.observedAt,
  };
  // The measurement travels; the measured content does not. A ledger event
  // must never hydrate the withheld record it witnesses.
  if (measurement !== null) {
    event.contaminationScore = measurement.score;
    event.contaminationThreshold = measurement.threshold;
    event.contaminationMatchedNgrams = measurement.matchedNgrams;
    event.contaminationTotalNgrams = measurement.totalNgrams;
  }
  return event;
}

/**
 * @param {object} input
 * @param {string} input.workspaceId               workspace the recall is for
 * @param {Array}  input.records                   records the query engine selected
 * @param {string} [input.currentTrustPolicyVersion] from getTrustPolicyVersion()
 * @param {number} [input.minConfidence]           provenance floor; omitted = off
 * @param {string} [input.observedAt]              ISO timestamp for ledger events
 * @param {object} [input.decontamination]         self-contamination screen (#3464);
 *   `{ corpus: string[], threshold?, ngramSize? }`; omitted or empty = off
 */
function evaluateMemoryRecall(input = {}) {
  if (!isPlainObject(input)) {
    return failure([{ code: 'VALIDATION_ERROR', field: 'input', message: 'input must be an object' }]);
  }

  const workspaceId = trimText(input.workspaceId);
  if (!workspaceId) {
    return failure([{ code: 'VALIDATION_ERROR', field: 'workspaceId', message: 'workspaceId is required' }]);
  }
  if (!Array.isArray(input.records)) {
    return failure([{ code: 'VALIDATION_ERROR', field: 'records', message: 'records must be an array' }]);
  }

  // Opt-in self-contamination screen, validated once up front so every
  // record is measured against the same corpus and threshold. Any invalid
  // option fails the whole call closed: admitting records while the screen
  // is half-configured would be the leak this option exists to prevent.
  let decontamination = null;
  if (input.decontamination !== undefined && input.decontamination !== null) {
    if (!isPlainObject(input.decontamination)) {
      return failure([{ code: 'VALIDATION_ERROR', field: 'decontamination', message: 'decontamination must be an object' }]);
    }
    const { corpus, threshold, ngramSize } = input.decontamination;
    if (!Array.isArray(corpus)) {
      return failure([{ code: 'VALIDATION_ERROR', field: 'decontamination.corpus', message: 'decontamination.corpus must be an array of strings' }]);
    }
    if (corpus.length > 0) {
      const probe = evaluateDecontamination({ text: '', corpus, threshold, ngramSize });
      if (!probe.ok) return failure(probe.errors);
      decontamination = { corpus, threshold: probe.threshold, ngramSize: probe.ngramSize };
    }
  }

  const warnings = [];
  const currentTrustPolicyVersion = trimText(input.currentTrustPolicyVersion);
  if (!currentTrustPolicyVersion) {
    warnings.push({
      code: 'POLICY_VERSION_UNKNOWN',
      field: 'currentTrustPolicyVersion',
      message: 'no current trust policy version supplied; staleness was not evaluated',
    });
  }

  let minConfidence = null;
  if (input.minConfidence !== undefined && input.minConfidence !== null) {
    const parsed = Number(input.minConfidence);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      return failure([{ code: 'VALIDATION_ERROR', field: 'minConfidence', message: 'minConfidence must be between 0 and 1' }]);
    }
    minConfidence = parsed;
  }

  const context = {
    workspaceId,
    currentTrustPolicyVersion,
    minConfidence,
    decontamination,
    observedAt: trimText(input.observedAt) || new Date().toISOString(),
  };
  context.observedAtMs = Date.parse(context.observedAt);
  if (Number.isNaN(context.observedAtMs)) {
    return failure([{ code: 'VALIDATION_ERROR', field: 'observedAt', message: 'observedAt must be a parseable timestamp' }]);
  }

  const decisions = [];
  const admitted = [];
  const degraded = [];
  const withheld = [];
  const ledgerEvents = [];

  for (const record of input.records) {
    const { signals, measurement } = signalsFor(record, context);
    const { decision, reason } = strictestOf(signals);
    const verdict = {
      memoryId: isPlainObject(record) ? trimText(record.memoryId) : '',
      decision,
      reason,
      signals,
    };
    if (measurement !== null) verdict.decontamination = measurement;
    decisions.push(verdict);

    if (decision === 'admit') {
      admitted.push(record);
      continue;
    }

    const entry = {
      memoryId: verdict.memoryId,
      reason,
      recordedTrustPolicyVersion: isPlainObject(record) ? trimText(record.trustPolicyVersion) : '',
      currentTrustPolicyVersion,
    };
    if (measurement !== null) {
      entry.contaminationScore = measurement.score;
      entry.contaminationThreshold = measurement.threshold;
    }
    if (decision === 'degrade') degraded.push(entry);
    else withheld.push(entry);
    ledgerEvents.push(ledgerEventFor(verdict, record, context, measurement));
  }

  return {
    ok: true,
    type: 'memory-recall-decision',
    policyVersion: MEMORY_RECALL_POLICY_VERSION,
    workspaceId,
    decisions,
    admitted,
    degraded,
    withheld,
    ledgerEvents,
    summary: {
      considered: input.records.length,
      admitted: admitted.length,
      degraded: degraded.length,
      withheld: withheld.length,
    },
    warnings,
    errors: [],
  };
}

module.exports = {
  MEMORY_RECALL_DECISIONS,
  MEMORY_RECALL_POLICY_VERSION,
  MEMORY_RECALL_POLICY_DECISION_SEVERITY: DECISION_SEVERITY,
  LEDGER_EVENT_TYPES,
  evaluateMemoryRecall,
};
