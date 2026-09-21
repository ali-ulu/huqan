'use strict';

const MAX_COUNTER = 2_147_483_647;
const MAX_SAMPLES = 2_048;
const MAX_LABELS = 32;
const GRAPH_OPERATIONS = Object.freeze(['read', 'write', 'delete', 'traverse']);
const APPROVAL_OUTCOMES = Object.freeze(['allow', 'review', 'block']);

function createObservabilityInternalMetrics() {
  const statsByWorkspace = new Map();

  function emptyStats() {
    return {
      eventWritesAttempted: 0,
      eventWritesSucceeded: 0,
      eventWritesFailed: 0,
      droppedEvents: 0,
      projectionFailures: 0,
      summaryCalls: 0,
      summaryDurationMs: 0,
      summarySlowCalls: 0,
      alertEvaluations: 0,
      alertEvaluationFailures: 0,
      alertEvaluationDurationMs: 0,
      databaseOperations: 0,
      databaseDurationMs: 0,
      databaseSlowOperations: 0,
      verificationLatencies: [],
      retrievalLatencies: [],
      graphOperations: { read: 0, write: 0, delete: 0, traverse: 0 },
      deniedActions: new Map(),
      approvalRequests: { allow: 0, review: 0, block: 0 },
      dbErrors: new Map(),
      rustFallbackTotal: 0,
    };
  }

  function statsFor(workspaceId) {
    const workspace = String(workspaceId);
    if (!statsByWorkspace.has(workspace)) statsByWorkspace.set(workspace, emptyStats());
    return statsByWorkspace.get(workspace);
  }

  function increment(stats, field, amount = 1) {
    stats[field] = Math.min(MAX_COUNTER, stats[field] + Math.max(0, Math.floor(Number(amount) || 0)));
  }

  function addDuration(stats, field, durationMs) {
    increment(stats, field, durationMs);
  }

  function recordSample(samples, value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) return;
    if (samples.length >= MAX_SAMPLES) samples.shift();
    samples.push(numeric);
  }

  function percentile(samples, quantile) {
    if (samples.length === 0) return null;
    const sorted = samples.slice().sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
    return Math.round(sorted[Math.max(0, index)] * 1000) / 1000;
  }

  function latencySnapshot(samples) {
    return {
      count: samples.length,
      p50: percentile(samples, 0.50),
      p95: percentile(samples, 0.95),
      p99: percentile(samples, 0.99),
    };
  }

  function normalizeLabel(value) {
    const label = String(value || '').trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, '_').slice(0, 80);
    return label || 'unknown';
  }

  function incrementLabel(map, rawLabel) {
    let label = normalizeLabel(rawLabel);
    if (!map.has(label) && map.size >= MAX_LABELS - 1) label = 'other';
    map.set(label, Math.min(MAX_COUNTER, (map.get(label) || 0) + 1));
  }

  function mapSnapshot(map) {
    return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }

  function startTimer(workspaceId, callsField, durationField, slowCallsField = null) {
    const stats = statsFor(workspaceId);
    increment(stats, callsField);
    const started = process.hrtime.bigint();
    let finished = false;
    return ({ failed = false } = {}) => {
      if (finished) return;
      finished = true;
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      addDuration(stats, durationField, durationMs);
      if (slowCallsField && durationMs >= 100) increment(stats, slowCallsField);
      if (failed) increment(stats, callsField === 'alertEvaluations' ? 'alertEvaluationFailures' : 'projectionFailures');
    };
  }

  function snapshot(workspaceId, subscriberCount) {
    const workspace = String(workspaceId);
    const stats = statsFor(workspace);
    return {
      workspaceId: workspace,
      subscriberCount: Math.max(0, Math.floor(Number(subscriberCount) || 0)),
      eventWrites: {
        attempted: stats.eventWritesAttempted,
        succeeded: stats.eventWritesSucceeded,
        failed: stats.eventWritesFailed,
      },
      droppedEvents: stats.droppedEvents,
      projectionFailures: stats.projectionFailures,
      summary: {
        calls: stats.summaryCalls,
        totalDurationMs: stats.summaryDurationMs,
        slowCalls: stats.summarySlowCalls,
      },
      alertEvaluation: {
        calls: stats.alertEvaluations,
        failures: stats.alertEvaluationFailures,
        totalDurationMs: stats.alertEvaluationDurationMs,
      },
      database: {
        calls: stats.databaseOperations,
        totalDurationMs: stats.databaseDurationMs,
        slowCalls: stats.databaseSlowOperations,
      },
      verification_latency_ms: latencySnapshot(stats.verificationLatencies),
      retrieval_latency_ms: latencySnapshot(stats.retrievalLatencies),
      graph_operations_total: { ...stats.graphOperations },
      denied_actions_total: mapSnapshot(stats.deniedActions),
      approval_requests_total: { ...stats.approvalRequests },
      db_errors_total: mapSnapshot(stats.dbErrors),
      rust_fallback_total: stats.rustFallbackTotal,
    };
  }

  return Object.freeze({
    recordEventWriteAttempt: workspaceId => increment(statsFor(workspaceId), 'eventWritesAttempted'),
    recordEventWriteSuccess: workspaceId => increment(statsFor(workspaceId), 'eventWritesSucceeded'),
    recordEventWriteFailure: workspaceId => increment(statsFor(workspaceId), 'eventWritesFailed'),
    recordDroppedEvent: workspaceId => increment(statsFor(workspaceId), 'droppedEvents'),
    recordProjectionFailure: workspaceId => increment(statsFor(workspaceId), 'projectionFailures'),
    recordVerificationLatency: (workspaceId, durationMs) => recordSample(statsFor(workspaceId).verificationLatencies, durationMs),
    recordRetrievalLatency: (workspaceId, durationMs) => recordSample(statsFor(workspaceId).retrievalLatencies, durationMs),
    recordGraphOperation(workspaceId, type) {
      const operation = normalizeLabel(type);
      if (GRAPH_OPERATIONS.includes(operation)) {
        const stats = statsFor(workspaceId);
        stats.graphOperations[operation] = Math.min(MAX_COUNTER, stats.graphOperations[operation] + 1);
      }
    },
    recordDeniedAction: (workspaceId, reason) => incrementLabel(statsFor(workspaceId).deniedActions, reason),
    recordApprovalRequest(workspaceId, outcome) {
      const normalized = normalizeLabel(outcome);
      if (APPROVAL_OUTCOMES.includes(normalized)) {
        const stats = statsFor(workspaceId);
        stats.approvalRequests[normalized] = Math.min(MAX_COUNTER, stats.approvalRequests[normalized] + 1);
      }
    },
    recordDbError: (workspaceId, errorType) => incrementLabel(statsFor(workspaceId).dbErrors, errorType),
    recordRustFallback: workspaceId => increment(statsFor(workspaceId), 'rustFallbackTotal'),
    startSummary: workspaceId => startTimer(workspaceId, 'summaryCalls', 'summaryDurationMs', 'summarySlowCalls'),
    startAlertEvaluation: workspaceId => startTimer(workspaceId, 'alertEvaluations', 'alertEvaluationDurationMs'),
    startDatabaseOperation: workspaceId => startTimer(workspaceId, 'databaseOperations', 'databaseDurationMs', 'databaseSlowOperations'),
    measureDatabase(workspaceId, operation) {
      if (typeof operation !== 'function') throw new TypeError('database operation must be a function');
      const finish = startTimer(workspaceId, 'databaseOperations', 'databaseDurationMs', 'databaseSlowOperations');
      try {
        return operation();
      } catch (error) {
        incrementLabel(statsFor(workspaceId).dbErrors, error?.code || error?.name || 'unknown');
        throw error;
      } finally {
        finish();
      }
    },
    snapshot,
  });
}

module.exports = { createObservabilityInternalMetrics };
