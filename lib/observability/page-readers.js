'use strict';

const { decodePageCursor, projectPage } = require('./pagination');
const {
  normalizeInteger,
  normalizeLimit,
  normalizeWorkspaceId,
  nowMs,
  projectAlert,
  projectJob,
  projectRule,
} = require('./helpers');

const MAX_ALERT_LIMIT = 100;
const MAX_METRIC_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;

function createObservabilityPageReaders({ db, now = Date.now } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('database handle is required');

  function pageAlertRules({ workspaceId, limit, cursor } = {}) {
    const workspace = normalizeWorkspaceId(workspaceId);
    const pageSize = normalizeLimit(limit, 50, MAX_ALERT_LIMIT);
    const decoded = decodePageCursor(cursor);
    const params = [workspace];
    let boundary = '';
    if (decoded) {
      boundary = 'AND (updated_at < ? OR (updated_at = ? AND rule_id < ?))';
      params.push(decoded.ts, decoded.ts, decoded.id);
    }
    params.push(pageSize + 1);
    const rows = db.prepare(`SELECT * FROM observability_alert_rules WHERE workspace_id = ? ${boundary}
      ORDER BY updated_at DESC, rule_id DESC LIMIT ?`).all(...params);
    return projectPage(rows, pageSize, projectRule, 'updated_at', 'rule_id');
  }

  function pageAlerts({ workspaceId, limit, cursor, windowMs } = {}) {
    const workspace = normalizeWorkspaceId(workspaceId);
    const pageSize = normalizeLimit(limit, 50, MAX_ALERT_LIMIT);
    const decoded = decodePageCursor(cursor);
    const params = [workspace];
    const clauses = ['workspace_id = ?'];
    if (windowMs !== undefined) {
      clauses.push('fired_at >= ?');
      params.push(nowMs(now) - Math.min(MAX_METRIC_WINDOW_MS, Math.max(1_000, normalizeInteger(windowMs) ?? 1_000)));
    }
    if (decoded) {
      clauses.push('(fired_at < ? OR (fired_at = ? AND alert_id < ?))');
      params.push(decoded.ts, decoded.ts, decoded.id);
    }
    params.push(pageSize + 1);
    const rows = db.prepare(`SELECT * FROM observability_alerts WHERE ${clauses.join(' AND ')}
      ORDER BY fired_at DESC, alert_id DESC LIMIT ?`).all(...params);
    return projectPage(rows, pageSize, projectAlert, 'fired_at', 'alert_id');
  }

  function pageQueue({ workspaceId, limit, cursor, status, windowMs } = {}) {
    const workspace = normalizeWorkspaceId(workspaceId);
    const pageSize = normalizeLimit(limit, 50, MAX_ALERT_LIMIT);
    const decoded = decodePageCursor(cursor);
    const params = [workspace];
    const clauses = ['workspace_id = ?'];
    if (windowMs !== undefined) {
      clauses.push('updated_at >= ?');
      params.push(nowMs(now) - Math.min(MAX_METRIC_WINDOW_MS, Math.max(1_000, normalizeInteger(windowMs) ?? 1_000)));
    }
    if (status) {
      clauses.push('status = ?');
      params.push(String(status));
    }
    if (decoded) {
      clauses.push('(updated_at < ? OR (updated_at = ? AND job_id < ?))');
      params.push(decoded.ts, decoded.ts, decoded.id);
    }
    params.push(pageSize + 1);
    const rows = db.prepare(`SELECT * FROM agent_queue_jobs WHERE ${clauses.join(' AND ')}
      ORDER BY updated_at DESC, job_id DESC LIMIT ?`).all(...params);
    return projectPage(rows, pageSize, projectJob, 'updated_at', 'job_id');
  }

  return { pageAlertRules, pageAlerts, pageQueue };
}

module.exports = { createObservabilityPageReaders };
