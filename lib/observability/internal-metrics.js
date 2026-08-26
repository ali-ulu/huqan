'use strict';

const MAX_COUNTER = 2_147_483_647;

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
    };
  }

  return Object.freeze({
    recordEventWriteAttempt: workspaceId => increment(statsFor(workspaceId), 'eventWritesAttempted'),
    recordEventWriteSuccess: workspaceId => increment(statsFor(workspaceId), 'eventWritesSucceeded'),
    recordEventWriteFailure: workspaceId => increment(statsFor(workspaceId), 'eventWritesFailed'),
    recordDroppedEvent: workspaceId => increment(statsFor(workspaceId), 'droppedEvents'),
    recordProjectionFailure: workspaceId => increment(statsFor(workspaceId), 'projectionFailures'),
    startSummary: workspaceId => startTimer(workspaceId, 'summaryCalls', 'summaryDurationMs', 'summarySlowCalls'),
    startAlertEvaluation: workspaceId => startTimer(workspaceId, 'alertEvaluations', 'alertEvaluationDurationMs'),
    snapshot,
  });
}

module.exports = { createObservabilityInternalMetrics };
