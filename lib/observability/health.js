'use strict';

const REQUIRED_TABLES = Object.freeze([
  'observability_events',
  'observability_runs',
  'observability_alert_rules',
  'observability_alerts',
  'agent_queue_jobs',
]);

function createObservabilityHealth({ getDb, getWorkerState, now = Date.now } = {}) {
  if (typeof getDb !== 'function' || typeof getWorkerState !== 'function') {
    throw new TypeError('observability health dependencies are required');
  }

  function inspect(workspaceId) {
    const workspace = String(workspaceId || '').trim();
    if (!workspace) {
      const error = new Error('workspaceId is required');
      error.code = 'INVALID_WORKSPACE_ID';
      throw error;
    }
    const checkedAtMs = Number(now());
    const worker = getWorkerState();
    const base = {
      liveness: { ok: true },
      readiness: { ok: false },
      database: { ok: false },
      schema: { ok: false, missingTables: [...REQUIRED_TABLES] },
      worker: {
        enabled: Boolean(worker?.enabled),
        running: Boolean(worker?.running),
        busy: Boolean(worker?.busy),
      },
      queue: { depth: null, lagMs: null },
      lastEventWriteAt: null,
      checkedAt: new Date(checkedAtMs).toISOString(),
    };
    try {
      const db = getDb();
      db.prepare('SELECT 1 AS ok').get();
      base.database.ok = true;
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
      base.schema.missingTables = REQUIRED_TABLES.filter(table => !tables.has(table));
      base.schema.ok = base.schema.missingTables.length === 0;
      if (base.schema.ok) {
        const queue = db.prepare(`SELECT COUNT(*) AS depth, MIN(created_at) AS oldest
          FROM agent_queue_jobs WHERE workspace_id = ? AND status IN ('queued', 'running')`).get(workspace);
        base.queue.depth = Number(queue.depth || 0);
        base.queue.lagMs = queue.oldest === null ? 0 : Math.max(0, checkedAtMs - Number(queue.oldest));
        const event = db.prepare('SELECT MAX(created_at) AS latest FROM observability_events WHERE workspace_id = ?').get(workspace);
        base.lastEventWriteAt = event.latest === null ? null : new Date(Number(event.latest)).toISOString();
      }
      base.readiness.ok = base.database.ok && base.schema.ok && (!base.worker.enabled || base.worker.running);
      return base;
    } catch (error) {
      return { ...base, error: { code: 'OBSERVABILITY_DATABASE_UNAVAILABLE' } };
    }
  }

  return { inspect };
}

module.exports = { REQUIRED_TABLES, createObservabilityHealth };
