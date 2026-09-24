'use strict';
// The observability service: composes the event writer, run recorder,
// read queries, alert rules, job queue and alert lifecycle over one
// database handle. The parts live in service-*.js (#2147).
const { applyObservabilityMigrations } = require('./migrations');
const { createObservabilityRetention } = require('./retention');
const { createAlertLifecycle } = require('./alert-lifecycle');
const { createObservabilityInternalMetrics } = require('./internal-metrics');
const { notifySafely } = require('./notification-adapter');
const {
  cursorDecode,
  cursorEncode,
  digestText,
  extractUsage,
  normalizeInteger,
  normalizeWorkspaceId,
  projectEvent,
  safePayload,
} = require('./helpers');
const { ALERT_METRICS, ALERT_OPERATORS, EVENT_TYPES } = require('./service-constants');
const { prepareObservabilityStatements } = require('./service-statements');
const { createObservabilityEvents } = require('./service-events');
const { createObservabilityRuns } = require('./service-runs');
const { createObservabilityQueries } = require('./service-queries');
const { createObservabilityAlertRules } = require('./service-alert-rules');
const { createObservabilityJobs } = require('./service-jobs');
function createObservabilityService({ db, now = Date.now, costPer1kTokensMicros = null, notificationAdapter = null } = {}) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') {
    throw new TypeError('database handle is required');
  }
  applyObservabilityMigrations(db);
  const retention = createObservabilityRetention({ db, now });
  const subscribers = new Set();
  const costRate = normalizeInteger(costPer1kTokensMicros);
  const internalMetrics = createObservabilityInternalMetrics();
  function getInternalMetrics({ workspaceId } = {}) {
    const workspace = normalizeWorkspaceId(workspaceId);
    const subscriberCount = [...subscribers].filter(subscriber => subscriber.workspaceId === workspace).length;
    return internalMetrics.snapshot(workspace, subscriberCount);
  }
  const statements = prepareObservabilityStatements(db);
  // Resolved per call: the lifecycle below is built from insertEvent.
  const deferredAlerts = { evaluateAlerts: (workspaceId, event) => alertLifecycle.evaluateAlerts(workspaceId, event) };
  const { insertEvent } = createObservabilityEvents({
    now, statements, costRate, internalMetrics, subscribers, alertLifecycle: deferredAlerts,
  });
  const {
    upsertRun, recordRunStart, recordRunFinish, recordStep, recordLifecycle, recordGateDecision,
  } = createObservabilityRuns({ now, statements, internalMetrics, insertEvent });
  const { listEvents, listRuns, summary } = createObservabilityQueries({ db, now, statements, internalMetrics });
  const { createAlertRule, listAlertRules, deleteAlertRule, listAlerts } = createObservabilityAlertRules({ now, statements });
  const {
    enqueueJob, recoverExpiredJobs, claimNextJob, finishJob, retryJob, listQueue, queueSummary,
  } = createObservabilityJobs({ db, now, statements, internalMetrics, insertEvent });
  function subscribe(listener, { workspaceId = null } = {}) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    const workspace = workspaceId === null || workspaceId === undefined ? null : normalizeWorkspaceId(workspaceId);
    const subscriber = { listener, workspaceId: workspace };
    subscribers.add(subscriber);
    return () => subscribers.delete(subscriber);
  }

  const alertLifecycle = createAlertLifecycle({
    statements,
    insertEvent,
    summary,
    notify: notificationAdapter ? input => notifySafely(notificationAdapter, input) : null,
    now,
  });

  return {
    createAlertRule,
    deleteAlertRule,
    enqueueJob,
    extractUsage,
    finishJob,
    claimNextJob,
    cleanup: retention.cleanup,
    listAlerts,
    listQueue,
    queueSummary,
    recoverExpiredJobs,
    retryJob,
    listAlertRules,
    listEvents,
    acknowledgeAlert: alertLifecycle.acknowledgeAlert,
    resolveAlert: alertLifecycle.resolveAlert,
    listRuns,
    internalMetrics: getInternalMetrics,
    recordGateDecision,
    recordLifecycle,
    recordRunFinish,
    recordRunStart,
    recordStep,
    subscribe,
    summary,
    upsertRun,
    _test: {
      ALERT_METRICS,
      ALERT_OPERATORS,
      EVENT_TYPES,
      cursorDecode,
      cursorEncode,
      digestText,
      projectEvent,
      safePayload,
    },
  };
}

module.exports = {
  ALERT_METRICS,
  ALERT_OPERATORS,
  EVENT_TYPES,
  createObservabilityService,
  digestText,
  extractUsage,
  normalizeWorkspaceId,
};
