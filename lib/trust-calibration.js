'use strict';

/**
 * Trust calibration engine (#3034).
 *
 * Every provenance record carries two confidences: what the caller declared
 * (`declaredConfidence`) and what the system applied after policy capping
 * (`confidence`). That separation (#2794's F1a) exists so that a later
 * calibration step can distrust declarations based on track record without
 * changing what any gate decides today. This module is that step.
 *
 * The unit of calibration is the `(actor, sourceType)` pair. For each pair
 * it pairs the confidence an actor declared at ingest with what actually
 * happened to the claim afterwards, read from the durable audit trail:
 *
 *   - `verified`   — the claim was accepted (CLAIM_ACCEPTED / REAFFIRMED)
 *   - `contradicted` — the claim was rejected or flagged as a conflict
 *     (CLAIM_REJECTED / CLAIM_FLAGGED / CONFLICT_DETECTED)
 *
 * Outcomes arrive in the same audit vocabulary every other component
 * already writes, so calibration adds no new write path and no new verdict
 * vocabulary: it reads what the system already swore to. The verdict is a
 * *suggested* cap only — adjusting trust policy caps is a deployment
 * decision, applied by an operator through policy files. Calibration is
 * decision support with a durable trail, not a self-modifying gate.
 *
 * Verdicts are journaled once per (actor, sourceType) per run through the
 * graph's mutation journal (same durability contract as the sibling
 * ledgers), so reopening the store replays rather than forks rows, and the
 * number of verdicts stays exactly the number of pairs observed.
 */

const CALIBRATION_SCHEMA_VERSION = 'huqan-trust-calibration-v1';
const CALIBRATION_OPERATION_PREFIX = 'trust-calibration:';
const { isPlainObject } = require('./is-plain-object');

// Audit event types that count as the outcome half of a (declaration,
// outcome) pair. Deliberately narrow: a QUERY is not a verification, and
// counting reads as confirmations would inflate trust without evidence.
const VERIFIED_EVENTS = Object.freeze(['CLAIM_ACCEPTED', 'REAFFIRMED']);
const CONTRADICTED_EVENTS = Object.freeze(['CLAIM_REJECTED', 'CLAIM_FLAGGED', 'CONFLICT_DETECTED']);

const DRIFT_CONFLICT_REASON = 'provenance_drift';
const DRIFT_CONFLICT_CODE = 'content_drift';

function clamp01(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1, num));
}

function requireGraph(graph) {
  if (!graph || typeof graph !== 'object' || typeof graph.getAuditEvents !== 'function') {
    throw new TypeError('graph with getAuditEvents is required');
  }
  return graph;
}

/**
 * A threshold that gates a trust decision must be a finite, non-negative
 * number. `NaN`, `Infinity`, a negative value or a non-number would make
 * `totalOutcomes >= threshold` silently false and switch the downgrade off,
 * which is fail-open: a mistyped threshold must throw, not disable calibration.
 */
function requireFiniteThreshold(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be a finite, non-negative number`);
  }
  return value;
}

/**
 * Collect the provenance records a calibration run sees: canonical nodes
 * and candidate claims from the graph. One record per (actor, sourceType,
 * provenanceId); records without a declared confidence cannot say anything
 * about the actor's honesty and are skipped.
 */
function collectDeclaredRecords(graph, workspaceId) {
  const records = [];
  const push = (provenance) => {
    if (!isPlainObject(provenance)) return;
    const actor = typeof provenance.actor === 'string' ? provenance.actor.trim() : '';
    const sourceType = typeof provenance.sourceType === 'string' ? provenance.sourceType.trim().toLowerCase() : '';
    const declared = provenance.declaredConfidence;
    if (!actor || !sourceType || typeof declared !== 'number' || !Number.isFinite(declared)) return;
    records.push({
      actor,
      sourceType,
      declared: clamp01(declared, 0.5),
      confidence: typeof provenance.confidence === 'number' ? clamp01(provenance.confidence, 0.5) : null,
      provenanceId: typeof provenance.provenanceId === 'string' ? provenance.provenanceId : '',
      sourceRef: typeof provenance.sourceRef === 'string' ? provenance.sourceRef : '',
    });
  };

  if (typeof graph.getNodes === 'function') {
    for (const node of Object.values(graph.getNodes(workspaceId) || {})) {
      push(node && node.provenance);
    }
  }
  if (typeof graph.getCandidateClaims === 'function') {
    for (const candidate of graph.getCandidateClaims({ workspaceId }) || []) {
      push(candidate && candidate.provenance);
    }
  }
  return records;
}

/**
 * Outcome counts per (actor, sourceType), from the audit trail. An event
 * carries its provenance fields either inline (details) or nested under
 * `provenance` — both shapes appear in the wild, so both are read.
 */
function collectOutcomes(graph, workspaceId) {
  const outcomes = new Map();
  const bump = (actor, sourceType, kind) => {
    if (!actor || !sourceType) return;
    const key = `${actor}\u0000${sourceType}`;
    const row = outcomes.get(key) || { verified: 0, contradicted: 0 };
    row[kind] += 1;
    outcomes.set(key, row);
  };
  const classify = (eventType) => {
    if (VERIFIED_EVENTS.includes(eventType)) return 'verified';
    if (CONTRADICTED_EVENTS.includes(eventType)) return 'contradicted';
    return null;
  };
  const read = (event) => {
    if (!isPlainObject(event)) return;
    const kind = classify(event.eventType);
    if (!kind) return;
    const details = isPlainObject(event.details) ? event.details : {};
    const inline = details;
    const nested = isPlainObject(event.provenance) ? event.provenance : {};
    const actor = (typeof inline.actor === 'string' && inline.actor.trim()) || (typeof nested.actor === 'string' && nested.actor.trim()) || '';
    const sourceType = ((typeof inline.sourceType === 'string' && inline.sourceType.trim())
      || (typeof nested.sourceType === 'string' && nested.sourceType.trim()) || '').toLowerCase();
    bump(actor, sourceType, kind);
  };

  // The bounded read paths; both scopes are drained because audit pagination
  // is bounded by design and a calibration run wants the full trail.
  const drain = (events) => { for (const event of events || []) read(event); };
  if (typeof graph.queryAuditEvents === 'function') {
    let cursor = null;
    for (let page = 0; page < 1000; page += 1) {
      const result = graph.queryAuditEvents({ filters: { workspaceId }, limit: 1000, cursor, order: 'asc' });
      drain(result && result.items);
      cursor = result && result.hasMore ? result.nextCursor : null;
      if (!cursor) break;
    }
  } else {
    drain(graph.getAuditEvents({ workspaceId }));
  }
  return outcomes;
}

/**
 * Derive one pair's calibration verdict from its declared confidences and
 * outcome counts. Pure.
 *
 * `sampled` counts only records whose declared confidence is present — the
 * pairs calibration can actually learn from. `agreementRate` is the share
 * of outcomes that verified. `suggestedCap` moves the pair's observed
 * declaration ceiling down when a substantial majority of outcomes
 * contradicted the declarations and enough outcomes exist to say so
 * (`minOutcomes`); it never suggests raising a cap above the policy value
 * the pair already received — calibration with evidence can only lose
 * trust, gaining it back is an operator's decision.
 */
function deriveCalibrationVerdict({ actor, sourceType, records, verified, contradicted, minOutcomes = 5 }) {
  requireFiniteThreshold(minOutcomes, 'minOutcomes');
  const sampled = records.filter((record) => record.declared !== null);
  const declaredSum = sampled.reduce((sum, record) => sum + record.declared, 0);
  const meanDeclared = sampled.length > 0 ? declaredSum / sampled.length : null;
  const maxDeclared = sampled.length > 0 ? Math.max(...sampled.map((record) => record.declared)) : null;
  const totalOutcomes = verified + contradicted;
  const agreementRate = totalOutcomes > 0 ? verified / totalOutcomes : null;
  const downGrade = totalOutcomes >= minOutcomes && agreementRate !== null && agreementRate < 0.5 && maxDeclared !== null;
  return {
    schemaVersion: CALIBRATION_SCHEMA_VERSION,
    actor,
    sourceType,
    sampled,
    sampledCount: sampled.length,
    meanDeclared,
    maxDeclared,
    verified,
    contradicted,
    totalOutcomes,
    agreementRate,
    suggestedCap: downGrade ? Math.max(0, Math.round(maxDeclared * agreementRate * 100) / 100) : null,
    reason: downGrade
      ? `Outcomes contradicted declarations in ${Math.round((1 - agreementRate) * 100)}% of ${totalOutcomes} cases; suggest capping at ${Math.round(maxDeclared * agreementRate * 100) / 100}.`
      : 'Insufficient contradicting outcomes to suggest a cap change.',
  };
}

/**
 * The calibration run. Returns one verdict per (actor, sourceType) pair
 * that has at least one declared-confidence record, plus the run metadata.
 * Pure over the graph's reads — this is the report; `journalTrustCalibration`
 * is the durable trail.
 */
function runTrustCalibration(graph, { workspaceId = 'default', minOutcomes = 5 } = {}) {
  requireGraph(graph);
  requireFiniteThreshold(minOutcomes, 'minOutcomes');
  const records = collectDeclaredRecords(graph, workspaceId);
  const outcomes = collectOutcomes(graph, workspaceId);

  const byPair = new Map();
  for (const record of records) {
    const key = `${record.actor}\u0000${record.sourceType}`;
    const row = byPair.get(key) || { actor: record.actor, sourceType: record.sourceType, records: [] };
    row.records.push(record);
    byPair.set(key, row);
  }

  const verdicts = [];
  for (const { actor, sourceType, records: pairRecords } of byPair.values()) {
    const key = `${actor}\u0000${sourceType}`;
    const outcome = outcomes.get(key) || { verified: 0, contradicted: 0 };
    verdicts.push(deriveCalibrationVerdict({
      actor,
      sourceType,
      records: pairRecords,
      verified: outcome.verified,
      contradicted: outcome.contradicted,
      minOutcomes,
    }));
  }
  verdicts.sort((a, b) => (a.actor + a.sourceType).localeCompare(b.actor + b.sourceType));

  const withCap = verdicts.filter((verdict) => verdict.suggestedCap !== null);
  return {
    schemaVersion: CALIBRATION_SCHEMA_VERSION,
    workspaceId,
    minOutcomes,
    runAt: new Date().toISOString(),
    pairs: verdicts.length,
    sampledRecords: records.length,
    suggestCapCount: withCap.length,
    verdicts,
  };
}

/**
 * Journal the calibration run's verdicts. One durable row per verdict per
 * run; re-running replays the same rows rather than forking them. The
 * journal lives in the graph's mutation journal (same authority the sibling
 * ledgers use); a graph without it still returns the report, unjournaled.
 */
function journalTrustCalibration(graph, report) {
  requireGraph(graph);
  if (typeof graph.runMutationOnce !== 'function') return { journaled: 0, replayed: 0 };
  let journaled = 0;
  let replayed = 0;
  for (const verdict of report.verdicts) {
    const operationId = `${CALIBRATION_OPERATION_PREFIX}${verdict.actor}:${verdict.sourceType}:${report.runAt}`;
    const outcome = graph.runMutationOnce(operationId, () => ({
      calibrationVerdict: true,
      storeVersion: CALIBRATION_SCHEMA_VERSION,
      actor: verdict.actor,
      sourceType: verdict.sourceType,
      sampledCount: verdict.sampledCount,
      meanDeclared: verdict.meanDeclared,
      verified: verdict.verified,
      contradicted: verdict.contradicted,
      agreementRate: verdict.agreementRate,
      suggestedCap: verdict.suggestedCap,
    }));
    if (outcome && outcome.replayed) replayed += 1;
    else journaled += 1;
  }
  return { journaled, replayed };
}

/**
 * Memory health summary (#3034): the drift/conflict counts a status surface
 * shows. Reads only; every accessor failure degrades to a zero that states
 * itself, so `huqan.status` keeps answering on a degraded graph.
 */
function buildMemoryHealthSummary(kernel, { workspaceId = 'default' } = {}) {
  const graph = kernel && kernel.graph ? kernel.graph : kernel;
  const ws = workspaceId || 'default';
  const summary = {
    schemaVersion: 'huqan-memory-health-v1',
    workspaceId: ws,
    driftFindings: { pending: 0, accepted: 0, rejected: 0 },
    conflictCandidates: { pending: 0, accepted: 0, rejected: 0 },
    conflictsByType: {},
    lastCheckedAt: null,
  };

  let candidates = [];
  try {
    candidates = graph && typeof graph.getCandidateClaims === 'function'
      ? (graph.getCandidateClaims({ workspaceId: ws }) || [])
      : [];
  } catch (_) {
    candidates = [];
  }

  const bumpStatus = (bucket, candidate) => {
    const status = candidate && candidate.status;
    if (status === 'pending') bucket.pending += 1;
    else if (status === 'accepted') bucket.accepted += 1;
    else if (status === 'rejected') bucket.rejected += 1;
    else bucket.pending += 1;
  };

  for (const candidate of candidates) {
    if (!isPlainObject(candidate)) continue;
    const conflict = isPlainObject(candidate.conflict) ? candidate.conflict : null;
    if (conflict && conflict.drift && conflict.drift.code === DRIFT_CONFLICT_CODE) {
      bumpStatus(summary.driftFindings, candidate);
      summary.lastCheckedAt = conflict.drift.checkedAt || summary.lastCheckedAt;
      continue;
    }
    if (conflict && conflict.conflict === true) {
      bumpStatus(summary.conflictCandidates, candidate);
      const type = typeof conflict.type === 'string' && conflict.type ? conflict.type : 'unspecified';
      summary.conflictsByType[type] = (summary.conflictsByType[type] || 0) + 1;
    }
  }

  // Drift findings also surface through the audit trail (the ingest re-check
  // appends CONFLICT_DETECTED with a drift detail), including for sources
  // whose finding a reviewer has since resolved. Latest event wins.
  try {
    const events = graph && typeof graph.getAuditEvents === 'function'
      ? (graph.getAuditEvents({ workspaceId: ws, eventType: 'CONFLICT_DETECTED' }) || [])
      : [];
    for (const event of events) {
      const details = isPlainObject(event && event.details) ? event.details : {};
      if (details.drift !== DRIFT_CONFLICT_CODE) continue;
      summary.lastCheckedAt = details.checkedAt || summary.lastCheckedAt;
    }
  } catch (_) {
    // Degraded graph: counts stay at what the candidates said.
  }

  return summary;
}

module.exports = {
  CALIBRATION_SCHEMA_VERSION,
  CALIBRATION_OPERATION_PREFIX,
  VERIFIED_EVENTS,
  CONTRADICTED_EVENTS,
  runTrustCalibration,
  journalTrustCalibration,
  buildMemoryHealthSummary,
  deriveCalibrationVerdict,
  _internals: {
    collectDeclaredRecords,
    collectOutcomes,
  },
};
