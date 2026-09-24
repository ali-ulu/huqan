'use strict';
// #2147: read side -- paged event and run listings and the windowed summary
// the alert rules evaluate against.
const { cursorDecode, cursorEncode, normalizeLimit, normalizeWorkspaceId, nowMs, projectEvent, projectRun } = require('./helpers');
const { DEFAULT_METRIC_WINDOW_MS, normalizeMetricWindow } = require('./service-constants');
function createObservabilityQueries({ db, now, statements, internalMetrics }) {
  function listEvents({ workspaceId, limit, cursor, eventType, runId, windowMs } = {}) {
    const workspace = normalizeWorkspaceId(workspaceId);
    const pageSize = normalizeLimit(limit);
    const decoded = cursorDecode(cursor);
    const params = [workspace];
    const clauses = ['workspace_id = ?'];
    if (windowMs !== undefined && windowMs !== null && String(windowMs) !== '') {
      clauses.push('created_at >= ?');
      params.push(nowMs(now) - normalizeMetricWindow(windowMs));
    }
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

  function listRuns({ workspaceId, limit, cursor, status, windowMs } = {}) {
    const workspace = normalizeWorkspaceId(workspaceId);
    const pageSize = normalizeLimit(limit);
    const decoded = cursorDecode(cursor);
    const params = [workspace];
    const clauses = ['workspace_id = ?'];
    if (windowMs !== undefined && windowMs !== null && String(windowMs) !== '') {
      clauses.push('updated_at >= ?');
      params.push(nowMs(now) - normalizeMetricWindow(windowMs));
    }
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

  function summary({ workspaceId, windowMs = DEFAULT_METRIC_WINDOW_MS } = {}) {
    const workspace = normalizeWorkspaceId(workspaceId);
    const finishSummary = internalMetrics.startSummary(workspace);
    try {
      const window = normalizeMetricWindow(windowMs);
      const since = nowMs(now) - window;
      const aggregate = internalMetrics.measureDatabase(workspace, () => db.prepare(`SELECT
        COUNT(*) AS total_runs,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_runs,
        SUM(CASE WHEN status IN ('failed', 'blocked', 'partial') THEN 1 ELSE 0 END) AS failed_runs,
        AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms END) AS avg_latency_ms,
        SUM(CASE WHEN tokens IS NOT NULL THEN tokens ELSE 0 END) AS total_tokens,
        SUM(CASE WHEN cost_micros IS NOT NULL THEN cost_micros ELSE 0 END) AS total_cost_micros,
        SUM(CASE WHEN error_steps > 0 OR blocked_steps > 0 OR status IN ('failed', 'blocked') THEN 1 ELSE 0 END) AS error_runs
        FROM observability_runs WHERE workspace_id = ? AND updated_at >= ?`).get(workspace, since));
      const durations = internalMetrics.measureDatabase(workspace, () => db.prepare(`SELECT duration_ms FROM observability_runs
        WHERE workspace_id = ? AND updated_at >= ? AND duration_ms IS NOT NULL
        ORDER BY duration_ms ASC LIMIT 5000`).all(workspace, since)).map(row => Number(row.duration_ms));
      const p95 = durations.length ? durations[Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1)] : null;
      const terminal = Number(aggregate.completed_runs || 0) + Number(aggregate.failed_runs || 0);
      const queueDepth = Number(internalMetrics.measureDatabase(workspace, () => statements.countQueue.get(workspace))?.count || 0);
      const toolUsage = internalMetrics.measureDatabase(workspace, () => db.prepare(`SELECT tool, COUNT(*) AS call_count FROM observability_events
        WHERE workspace_id = ? AND event_type = 'step_finished' AND tool <> '' AND created_at >= ?
        GROUP BY tool ORDER BY call_count DESC, tool ASC`).all(workspace, since)).map(row => ({
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
          WHERE workspace_id = ? AND updated_at >= ? AND tokens IS NOT NULL`).get(workspace, since)).count > 0,
        totalCostMicros: aggregate.total_cost_micros === null ? null : Number(aggregate.total_cost_micros),
        costKnown: internalMetrics.measureDatabase(workspace, () => db.prepare(`SELECT COUNT(*) AS count FROM observability_runs
          WHERE workspace_id = ? AND updated_at >= ? AND cost_known = 1`).get(workspace, since)).count > 0,
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
