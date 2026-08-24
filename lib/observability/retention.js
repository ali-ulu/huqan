'use strict';

const MAX_AGE_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const DEFAULT_POLICY = Object.freeze({
  enabled: false,
  intervalMs: 60 * 60 * 1000,
  batchSize: 500,
  eventAgeMs: 30 * 24 * 60 * 60 * 1000,
  runAgeMs: 90 * 24 * 60 * 60 * 1000,
  alertAgeMs: 90 * 24 * 60 * 60 * 1000,
  queueAgeMs: 30 * 24 * 60 * 60 * 1000,
  workspaceIds: Object.freeze([]),
});

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    const error = new Error('Observability retention policy is invalid.');
    error.code = 'OBSERVABILITY_RETENTION_POLICY_INVALID';
    throw error;
  }
  return value;
}

function parseRetentionPolicy(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_POLICY;
  let input;
  try { input = JSON.parse(String(raw)); } catch (_) { input = null; }
  const keys = Object.keys(DEFAULT_POLICY);
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || typeof input.enabled !== 'boolean' || Object.keys(input).some(key => !keys.includes(key))) {
    const error = new Error('Observability retention policy is invalid.');
    error.code = 'OBSERVABILITY_RETENTION_POLICY_INVALID';
    throw error;
  }
  return Object.freeze({
    enabled: input.enabled,
    intervalMs: boundedInteger(input.intervalMs, DEFAULT_POLICY.intervalMs, 10_000, 24 * 60 * 60 * 1000),
    batchSize: boundedInteger(input.batchSize, DEFAULT_POLICY.batchSize, 1, 10_000),
    eventAgeMs: boundedInteger(input.eventAgeMs, DEFAULT_POLICY.eventAgeMs, 60_000, MAX_AGE_MS),
    runAgeMs: boundedInteger(input.runAgeMs, DEFAULT_POLICY.runAgeMs, 60_000, MAX_AGE_MS),
    alertAgeMs: boundedInteger(input.alertAgeMs, DEFAULT_POLICY.alertAgeMs, 60_000, MAX_AGE_MS),
    queueAgeMs: boundedInteger(input.queueAgeMs, DEFAULT_POLICY.queueAgeMs, 60_000, MAX_AGE_MS),
    workspaceIds: (() => {
      const values = input.workspaceIds === undefined ? [] : input.workspaceIds;
      if (!Array.isArray(values) || values.length > 100 || values.some(value => typeof value !== 'string'
          || !value || value === '*' || value !== value.trim() || value.length > 128 || /[\x00-\x1F\x7F]/.test(value))
          || new Set(values).size !== values.length || (input.enabled && values.length === 0)) {
        const error = new Error('Observability retention policy is invalid.');
        error.code = 'OBSERVABILITY_RETENTION_POLICY_INVALID';
        throw error;
      }
      return Object.freeze([...values]);
    })(),
  });
}

function createObservabilityRetention({ db, policy, now = Date.now, logger = console } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('retention database is required');
  const config = parseRetentionPolicy(policy);
  const statements = {
    events: db.prepare(`DELETE FROM observability_events WHERE event_id IN (
      SELECT event_id FROM observability_events e WHERE workspace_id = ? AND created_at < ?
      AND (run_id = '' OR NOT EXISTS (SELECT 1 FROM observability_runs r
        WHERE r.run_id = e.run_id AND r.workspace_id = e.workspace_id AND r.status = 'running'))
      ORDER BY created_at ASC, event_id ASC LIMIT ?)`),
    runs: db.prepare(`DELETE FROM observability_runs WHERE run_id IN (
      SELECT run_id FROM observability_runs WHERE workspace_id = ? AND updated_at < ? AND status <> 'running'
      ORDER BY updated_at ASC, run_id ASC LIMIT ?)`),
    alerts: db.prepare(`DELETE FROM observability_alerts WHERE alert_id IN (
      SELECT alert_id FROM observability_alerts WHERE workspace_id = ? AND fired_at < ? AND status IN ('resolved', 'acknowledged', 'suppressed')
      ORDER BY fired_at ASC, alert_id ASC LIMIT ?)`),
    queue: db.prepare(`DELETE FROM agent_queue_jobs WHERE job_id IN (
      SELECT job_id FROM agent_queue_jobs WHERE workspace_id = ? AND updated_at < ?
      AND status IN ('completed', 'failed') AND (lease_until IS NULL OR lease_until < ?)
      ORDER BY updated_at ASC, job_id ASC LIMIT ?)`),
  };

  function cleanup({ workspaceId } = {}) {
    const workspace = typeof workspaceId === 'string' ? workspaceId.trim() : '';
    if (!workspace) return Object.freeze({ ok: false, code: 'OBSERVABILITY_RETENTION_WORKSPACE_REQUIRED', deleted: 0 });
    if (!config.enabled) return Object.freeze({ ok: true, code: 'OBSERVABILITY_RETENTION_DISABLED', deleted: 0 });
    const timestamp = now();
    try {
      const execute = () => {
        const deleted = {
          events: statements.events.run(workspace, timestamp - config.eventAgeMs, config.batchSize).changes,
          runs: statements.runs.run(workspace, timestamp - config.runAgeMs, config.batchSize).changes,
          alerts: statements.alerts.run(workspace, timestamp - config.alertAgeMs, config.batchSize).changes,
          queue: statements.queue.run(workspace, timestamp - config.queueAgeMs, timestamp, config.batchSize).changes,
        };
        return Object.freeze({ ok: true, code: 'OBSERVABILITY_RETENTION_CLEANED', deleted, totalDeleted: Object.values(deleted).reduce((a, b) => a + b, 0) });
      };
      return typeof db.transaction === 'function' ? db.transaction(execute)() : execute();
    } catch (error) {
      logger?.error?.('[observability-retention] cleanup failed', { code: error.code || 'OBSERVABILITY_RETENTION_FAILED', workspaceId: workspace });
      return Object.freeze({ ok: false, code: 'OBSERVABILITY_RETENTION_FAILED', deleted: 0 });
    }
  }

  return Object.freeze({ cleanup, policy: config });
}

module.exports = { DEFAULT_POLICY, createObservabilityRetention, parseRetentionPolicy };
