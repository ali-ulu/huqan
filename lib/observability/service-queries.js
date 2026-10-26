'use strict';
// #2147: read side -- paged event and run listings and the windowed summary
// the alert rules evaluate against.
const { cursorDecode, cursorEncode, normalizeLimit, normalizeWorkspaceId, nowMs, projectEvent, projectRun } = require('./helpers');
const { DEFAULT_METRIC_WINDOW_MS, MAX_METRIC_WINDOW_MS, normalizeMetricWindow } = require('./service-constants');

// A custom range is absolute epoch milliseconds. Both bounds are required and
// ordered; anything else is INVALID_RANGE, which every query answers with an
// empty result instead of silently widening to the whole history.
const INVALID_RANGE = Object.freeze({ invalid: true });

function resolveRange(startMs, endMs) {
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs < 0 || startMs > endMs) return INVALID_RANGE;
  // The span is capped at the same maximum a relative window may cover.
  return { since: Math.max(startMs, endMs - MAX_METRIC_WINDOW_MS), until: endMs };
}

function resolveWindow(windowMs, startMs, endMs, nowRef) {
  if (startMs !== undefined || endMs !== undefined) return resolveRange(startMs, endMs);
  if (windowMs !== undefined && windowMs !== null && String(windowMs) !== '') {
    return { since: nowMs(nowRef) - normalizeMetricWindow(windowMs) };
  }
  return null;
}

function rangeSql(column, win) {
  return win.until === undefined
    ? { sql: `${column} >= ?`, params: [win.since] }
    : { sql: `${column} >= ? AND ${column} <= ?`, params: [win.since, win.until] };
}

function applyWindowClause(clauses, params, column, win) {
  const range = rangeSql(column, win);
  clauses.push(range.sql);
  params.push(...range.params);
}

function emptyPage(pageSize) {
  return { items: [], limit: pageSize, hasMore: false, nextCursor: null };
}

function emptySummary(workspace, nowRef) {
  return {
    workspaceId: workspace,
    windowMs: 0,
    since: null,
    totalRuns: 0, completedRuns: 0, failedRuns: 0,
    successRate: null, avgLatencyMs: null, p95LatencyMs: null,
    totalTokens: 0, tokenKnown: false,
    totalCostMicros: null, costKnown: false,
    errorRuns: 0, queueDepth: 0,
    toolUsage: [], toolCallCount: 0,
    generatedAt: new Date(nowMs(nowRef)).toISOString(),
  };
}

function createObservabilityQueries({ db, now, statements, internalMetrics }) {
  function listEvents({ workspaceId, limit, cursor, eventType, runId, windowMs, startMs, endMs } = {}) {
    const workspace = normalizeWorkspaceId(workspaceId);
    const pageSize = normalizeLimit(limit);
    const decoded = cursorDecode(cursor);
    const params = [workspace];
    const clauses = ['workspace_id = ?'];
    const win = resolveWindow(windowMs, startMs, endMs, now);
    if (win === INVALID_RANGE) return emptyPage(pageSize);
    if (win) applyWindowClause(clauses, params, 'created_at', win);
    if (eventType) { clauses.push('event_type = ?'); params.push(String(eventType)); }
    if (runId) { clauses.push('run_id = ?'); params.push(String(runId)); }
    if (decoded) {
      clauses.push('(created_at < ? OR (created_at = ? AND event_id < ?))');
      params.push(decoded.ts, decoded.ts, decoded.id);
    }
    params.push(pageSize + 1);
    const rows = internalMetrics.measureDatabase(workspace, () => db.prepare(`SELECT * FROM observability_events WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC, event_id DESC LIMIT ?`).all(...params));
    const hasMore = rows.length > pageSize;
    const page = rows.slice(0, pageSize).map(projectEvent);
    const last = page[page.length - 1];
    return { items: page, limit: pageSize, hasMore, nextCursor: hasMore && last ? cursorEncode({ ts: Date.parse(last.createdAt), id: last.eventId }) : null };
  }

  function listRuns({ workspaceId, limit, cursor, status, windowMs, startMs, endMs } = {}) {
    const workspace = normalizeWorkspaceId(workspaceId);
    const pageSize = normalizeLimit(limit);
    const decoded = cursorDecode(cursor);
    const params = [workspace];
    const clauses = ['workspace_id = ?'];
    const win = resolveWindow(windowMs, startMs, endMs, now);
    if (win === INVALID_RANGE) return emptyPage(pageSize);
    if (win) applyWindowClause(clauses, params, 'updated_at', win);
    if (status) { clauses.push('status = ?'); params.push(String(status)); }
    if (decoded) {
      clauses.push('(updated_at < ? OR (updated_at = ? AND run_id < ?))');
      params.push(decoded.ts, decoded.ts, decoded.id);
    }
    params.push(pageSize + 1);
    const rows = internalMetrics.measureDatabase(workspace, () => db.prepare(`SELECT * FROM observability_runs WHERE ${clauses.join(' AND ')}
      ORDER BY updated_at DESC, run_id DESC LIMIT ?`).all(...params));
    const hasMore = rows.length > pageSize;
    const page = rows.slice(0, pageSize).map(row => {
      const run = projectRun(row);
      const tools = internalMetrics.measureDatabase(workspace, () => statements.listToolsByRun.all(workspace, run.runId)).map(tool => ({
        name: tool.tool,
        count: Number(tool.call_count),
      }));
      return { ...run, tools, toolCallCount: tools.reduce((total, tool) => total + tool.count, 0) };
    });
    const last = rows[page.length - 1];
    return { items: page, limit: pageSize, hasMore, nextCursor: hasMore && last ? cursorEncode({ ts: Number(last.updated_at), id: last.run_id }) : null };
  }

  function summary({ workspaceId, windowMs = DEFAULT_METRIC_WINDOW_MS, startMs, endMs } = {}) {
    const workspace = normalizeWorkspaceId(workspaceId);
    const finishSummary = internalMetrics.startSummary(workspace);
    try {
      // A missing or blank windowMs keeps the default relative window.
      const win = resolveWindow(windowMs, startMs, endMs, now) || { since: nowMs(now) - normalizeMetricWindow(windowMs) };
      if (win === INVALID_RANGE) return emptySummary(workspace, now);
      const since = win.since;
      const window = (win.until === undefined ? nowMs(now) : win.until) - since;
      const runs = rangeSql('updated_at', win);
      const events = rangeSql('created_at', win);
      const aggregate = internalMetrics.measureDatabase(workspace, () => db.prepare(`SELECT
        COUNT(*) AS total_runs,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_runs,
        SUM(CASE WHEN status IN ('failed', 'blocked', 'partial') THEN 1 ELSE 0 END) AS failed_runs,
        AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms END) AS avg_latency_ms,
        SUM(CASE WHEN tokens IS NOT NULL THEN tokens ELSE 0 END) AS total_tokens,
        SUM(CASE WHEN cost_micros IS NOT NULL THEN cost_micros ELSE 0 END) AS total_cost_micros,
        SUM(CASE WHEN error_steps > 0 OR blocked_steps > 0 OR status IN ('failed', 'blocked') THEN 1 ELSE 0 END) AS error_runs
        FROM observability_runs WHERE workspace_id = ? AND ${runs.sql}`).get(workspace, ...runs.params));
      const durations = internalMetrics.measureDatabase(workspace, () => db.prepare(`SELECT duration_ms FROM observability_runs
        WHERE workspace_id = ? AND ${runs.sql} AND duration_ms IS NOT NULL
        ORDER BY duration_ms ASC LIMIT 5000`).all(workspace, ...runs.params)).map(row => Number(row.duration_ms));
      const p95 = durations.length ? durations[Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1)] : null;
      const terminal = Number(aggregate.completed_runs || 0) + Number(aggregate.failed_runs || 0);
      const queueDepth = Number(internalMetrics.measureDatabase(workspace, () => statements.countQueue.get(workspace))?.count || 0);
      const toolUsage = internalMetrics.measureDatabase(workspace, () => db.prepare(`SELECT tool, COUNT(*) AS call_count FROM observability_events
        WHERE workspace_id = ? AND event_type = 'step_finished' AND tool <> '' AND ${events.sql}
        GROUP BY tool ORDER BY call_count DESC, tool ASC`).all(workspace, ...events.params)).map(row => ({
          name: row.tool,
          count: Number(row.call_count),
        }));
      const toolCallCount = toolUsage.reduce((total, tool) => total + tool.count, 0);
      return {
        workspaceId: workspace,
        windowMs: window,
        since: new Date(since).toISOString(),
        totalRuns: Number(aggregate.total_runs || 0),
        completedRuns: Number(aggregate.completed_runs || 0),
        failedRuns: Number(aggregate.failed_runs || 0),
        successRate: terminal ? Number(aggregate.completed_runs || 0) / terminal : null,
        avgLatencyMs: aggregate.avg_latency_ms === null ? null : Number(aggregate.avg_latency_ms),
        p95LatencyMs: p95,
        totalTokens: Number(aggregate.total_tokens || 0),
        tokenKnown: internalMetrics.measureDatabase(workspace, () => db.prepare(`SELECT COUNT(*) AS count FROM observability_runs
          WHERE workspace_id = ? AND ${runs.sql} AND tokens IS NOT NULL`).get(workspace, ...runs.params)).count > 0,
        totalCostMicros: aggregate.total_cost_micros === null ? null : Number(aggregate.total_cost_micros),
        costKnown: internalMetrics.measureDatabase(workspace, () => db.prepare(`SELECT COUNT(*) AS count FROM observability_runs
          WHERE workspace_id = ? AND ${runs.sql} AND cost_known = 1`).get(workspace, ...runs.params)).count > 0,
        errorRuns: Number(aggregate.error_runs || 0),
        queueDepth,
        toolUsage,
        toolCallCount,
        generatedAt: new Date(nowMs(now)).toISOString(),
      };
    } finally {
      finishSummary();
    }
  }
  return { listEvents, listRuns, summary };
}
module.exports = { createObservabilityQueries };
