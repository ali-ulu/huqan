'use strict';

const DEFAULT_RETENTION_MS = Object.freeze({
  events: 7 * 24 * 60 * 60 * 1000,
  runs: 30 * 24 * 60 * 60 * 1000,
  alerts: 30 * 24 * 60 * 60 * 1000,
  queue: 7 * 24 * 60 * 60 * 1000,
});
const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 1_000;

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? Math.min(number, maximum) : fallback;
}

function normalizeRetentionMs(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return Object.freeze(Object.fromEntries(Object.entries(DEFAULT_RETENTION_MS).map(([name, fallback]) => [
    name,
    positiveInteger(source[name], fallback, 365 * 24 * 60 * 60 * 1000),
  ])));
}

function createObservabilityRetention({ db, now = Date.now, retentionMs = DEFAULT_RETENTION_MS } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('database handle is required');
  if (typeof now !== 'function') throw new TypeError('retention clock must be a function');
  const policy = normalizeRetentionMs(retentionMs);
  const statements = {
    events: db.prepare(`DELETE FROM observability_events
      WHERE rowid IN (
        SELECT candidate.rowid FROM observability_events AS candidate
        WHERE candidate.workspace_id = ? AND candidate.created_at < ?
          AND NOT EXISTS (
            SELECT 1 FROM observability_runs AS active
            WHERE active.workspace_id = candidate.workspace_id
              AND active.run_id = candidate.run_id
              AND active.status IN ('running', 'paused', 'review')
          )
        ORDER BY candidate.created_at ASC, candidate.event_id ASC LIMIT ?
      )`),
    runs: db.prepare(`DELETE FROM observability_runs
      WHERE rowid IN (
        SELECT rowid FROM observability_runs
        WHERE workspace_id = ? AND status IN ('completed', 'failed', 'blocked', 'partial') AND updated_at < ?
        ORDER BY updated_at ASC, run_id ASC LIMIT ?
      )`),
    alerts: db.prepare(`DELETE FROM observability_alerts
      WHERE rowid IN (
        SELECT rowid FROM observability_alerts
        WHERE workspace_id = ? AND status = 'resolved' AND resolved_at IS NOT NULL AND resolved_at < ?
        ORDER BY resolved_at ASC, alert_id ASC LIMIT ?
      )`),
    queue: db.prepare(`DELETE FROM agent_queue_jobs
      WHERE rowid IN (
        SELECT rowid FROM agent_queue_jobs
        WHERE workspace_id = ? AND status IN ('completed', 'failed', 'dead')
          AND lease_until IS NULL AND updated_at < ?
        ORDER BY updated_at ASC, job_id ASC LIMIT ?
      )`),
  };

  function cleanup({ workspaceId, batchSize = DEFAULT_BATCH_SIZE, at = now() } = {}) {
    const workspace = typeof workspaceId === 'string' ? workspaceId.trim() : '';
    if (!workspace || workspace !== workspaceId || workspace.length > 128 || /[\x00-\x1F\x7F]/.test(workspace)) {
      const error = new Error('workspaceId is required for observability cleanup.');
      error.code = 'INVALID_WORKSPACE_ID';
      throw error;
    }
    const timestamp = Number(at);
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
      const error = new Error('cleanup timestamp must be a non-negative integer.');
      error.code = 'INVALID_RETENTION_TIMESTAMP';
      throw error;
    }
    const limit = positiveInteger(batchSize, DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE);
    const execute = () => {
      const deleted = {};
      for (const [name, statement] of Object.entries(statements)) {
        deleted[name] = statement.run(workspace, timestamp - policy[name], limit).changes;
      }
      return {
        workspaceId: workspace,
        at: timestamp,
        batchSize: limit,
        retentionMs: policy,
        deleted,
        totalDeleted: Object.values(deleted).reduce((total, count) => total + count, 0),
      };
    };
    return typeof db.transaction === 'function' ? db.transaction(execute)() : execute();
  }

  return Object.freeze({ cleanup, policy });
}

module.exports = {
  DEFAULT_BATCH_SIZE,
  DEFAULT_RETENTION_MS,
  MAX_BATCH_SIZE,
  createObservabilityRetention,
};
