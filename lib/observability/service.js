'use strict';

const crypto = require('node:crypto');
const { createInternalMetrics } = require('./internal-metrics');
const { applyObservabilitySchema } = require('./schema');
const {
  clone,
  compareMetric,
  cursorDecode,
  cursorEncode,
  digestText,
  extractUsage,
  normalizeInteger,
  normalizeLimit,
  normalizeOptionalNumber,
  normalizeWorkspaceId,
  nowMs,
  parseJson,
  projectAlert,
  projectEvent,
  projectJob,
  projectRule,
  projectRun,
  safePayload,
} = require('./helpers');
const { decodePageCursor, projectPage } = require('./pagination');

const MAX_ALERT_LIMIT = 100;
const MAX_METRIC_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
const EVENT_TYPES = Object.freeze([
  'run_started',
  'run_finished',
  'step_finished',
  'gate_decision',
  'queue_enqueued',
  'queue_started',
  'queue_finished',
  'alert_firing',
  'alert_acknowledged',
  'alert_resolved',
]);
const ALERT_METRICS = Object.freeze([
  'success_rate',
  'avg_latency_ms',
  'p95_latency_ms',
  'token_total',
  'cost_micros',
  'error_count',
  'queue_depth',
]);
const ALERT_OPERATORS = Object.freeze(['gt', 'gte', 'lt', 'lte', 'eq']);

function createObservabilityService({ db, now = Date.now, costPer1kTokensMicros = null, notificationAdapter = null, logger = console } = {}) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') {
    throw new TypeError('database handle is required');
  }
  applyObservabilitySchema(db);
  const subscribers = new Set();
  const internal = createInternalMetrics({ now, logger });
  const costRate = normalizeInteger(costPer1kTokensMicros);

  const statements = {
    insertEvent: db.prepare(`INSERT INTO observability_events (
      event_id, workspace_id, run_id, trace_id, agent_id, event_type, status, tool,
      duration_ms, tokens, input_tokens, output_tokens, cost_micros, cost_known,
      payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    upsertRun: db.prepare(`INSERT INTO observability_runs (
      run_id, workspace_id, agent_id, runtime, goal_digest, goal_length, objective,
      status, started_at, finished_at, duration_ms, step_count, successful_steps,
      blocked_steps, error_steps, tokens, input_tokens, output_tokens, cost_micros,
      cost_known, error_code, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      workspace_id = excluded.workspace_id,
      agent_id = excluded.agent_id,
      runtime = excluded.runtime,
      goal_digest = excluded.goal_digest,
      goal_length = excluded.goal_length,
      objective = excluded.objective,
      status = excluded.status,
      started_at = excluded.started_at,
      finished_at = excluded.finished_at,
      duration_ms = excluded.duration_ms,
      step_count = excluded.step_count,
      successful_steps = excluded.successful_steps,
      blocked_steps = excluded.blocked_steps,
      error_steps = excluded.error_steps,
      tokens = excluded.tokens,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cost_micros = excluded.cost_micros,
      cost_known = excluded.cost_known,
      error_code = excluded.error_code,
      updated_at = excluded.updated_at`),
    getRun: db.prepare('SELECT * FROM observability_runs WHERE workspace_id = ? AND run_id = ?'),
    getLatestAlert: db.prepare(`SELECT * FROM observability_alerts
      WHERE workspace_id = ? AND rule_id = ? ORDER BY fired_at DESC LIMIT 1`),
    insertAlert: db.prepare(`INSERT INTO observability_alerts
      (alert_id, rule_id, workspace_id, metric, value, threshold, fingerprint, status, event_id, fired_at, acknowledged_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'firing', ?, ?, NULL, NULL)`),
    updateAlertStatus: db.prepare(`UPDATE observability_alerts SET status = ?, acknowledged_at = ?, resolved_at = ?
      WHERE workspace_id = ? AND alert_id = ? AND status IN ('firing', 'acknowledged')`),
    acknowledgeAlert: db.prepare(`UPDATE observability_alerts SET status = 'acknowledged', acknowledged_at = ?
      WHERE workspace_id = ? AND alert_id = ? AND status = 'firing'`),
    getAlert: db.prepare('SELECT * FROM observability_alerts WHERE workspace_id = ? AND alert_id = ?'),
    getRules: db.prepare(`SELECT * FROM observability_alert_rules
      WHERE workspace_id = ? ORDER BY updated_at DESC, rule_id DESC LIMIT ?`),
    getRule: db.prepare('SELECT * FROM observability_alert_rules WHERE workspace_id = ? AND rule_id = ?'),
    insertRule: db.prepare(`INSERT INTO observability_alert_rules
      (rule_id, workspace_id, name, metric, operator, threshold, window_ms, cooldown_ms, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    deleteRule: db.prepare('DELETE FROM observability_alert_rules WHERE workspace_id = ? AND rule_id = ?'),
    listAlerts: db.prepare(`SELECT * FROM observability_alerts
      WHERE workspace_id = ? ORDER BY fired_at DESC, alert_id DESC LIMIT ?`),
    countQueue: db.prepare(`SELECT COUNT(*) AS count FROM agent_queue_jobs
      WHERE workspace_id = ? AND status IN ('queued', 'running')`),
    insertJob: db.prepare(`INSERT INTO agent_queue_jobs
      (job_id, workspace_id, agent_id, goal, max_steps, status, attempts, max_attempts,
       available_at, lease_until, worker_id, run_id, result_json, error_code, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, NULL, '', '', '{}', '', ?, ?)`),
    getJob: db.prepare('SELECT * FROM agent_queue_jobs WHERE workspace_id = ? AND job_id = ?'),
    listJobs: db.prepare(`SELECT * FROM agent_queue_jobs
      WHERE workspace_id = ? ORDER BY updated_at DESC, job_id DESC LIMIT ?`),
    listToolsByRun: db.prepare(`SELECT tool, COUNT(*) AS call_count FROM observability_events
      WHERE workspace_id = ? AND run_id = ? AND event_type = 'step_finished' AND tool <> ''
      GROUP BY tool ORDER BY call_count DESC, tool ASC`),
    nextJob: db.prepare(`SELECT * FROM agent_queue_jobs
      WHERE status = 'queued' AND available_at <= ? ORDER BY available_at ASC, created_at ASC, job_id ASC LIMIT 1`),
    claimJob: db.prepare(`UPDATE agent_queue_jobs SET status = 'running', attempts = attempts + 1,
      lease_until = ?, worker_id = ?, updated_at = ? WHERE job_id = ? AND status = 'queued'`),
    completeJob: db.prepare(`UPDATE agent_queue_jobs SET status = ?, lease_until = NULL,
      worker_id = '', run_id = ?, result_json = ?, error_code = ?, updated_at = ?
      WHERE job_id = ? AND status = 'running' AND worker_id = ?`),
    retryJob: db.prepare(`UPDATE agent_queue_jobs SET status = ?, available_at = ?, lease_until = NULL,
      worker_id = '', error_code = ?, updated_at = ?
      WHERE job_id = ? AND status = 'running' AND worker_id = ?`),
    expiredLeases: db.prepare(`SELECT * FROM agent_queue_jobs
      WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until < ?
      ORDER BY lease_until ASC, job_id ASC`),
    recoverLease: db.prepare(`UPDATE agent_queue_jobs SET status = ?, lease_until = NULL,
      worker_id = '', available_at = ?, error_code = 'WORKER_LEASE_EXPIRED', updated_at = ?
      WHERE job_id = ? AND status = 'running' AND lease_until = ?`),
  };

  function dispatchNotification(alert, occurredAt) {
    if (!notificationAdapter || typeof notificationAdapter.deliver !== 'function') return;
    const payload = { ...alert, deliveryId: `${alert.alertId}:${alert.status}`, occurredAt };
    Promise.resolve().then(() => notificationAdapter.deliver(payload)).catch(error => {
      logger?.error?.('[observability-notification] delivery failed', {
        code: error?.code || 'OBSERVABILITY_NOTIFICATION_FAILED', alertId: alert.alertId, workspaceId: alert.workspaceId,
      });
    });
  }

  function publish(event) {
    for (const subscriber of subscribers) {
      try { subscriber(clone(event)); } catch (error) {
        internal.increment('subscriberDrops');
        logger?.error?.('[observability-internal] subscriber delivery failed', { code: error?.code || 'OBSERVABILITY_SUBSCRIBER_FAILED', workspaceId: event.workspaceId, runId: event.runId, traceId: event.traceId });
      }
    }
  }

  function insertEvent(input, { evaluate = true } = {}) {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const eventType = String(input.eventType || '').trim();
    if (!EVENT_TYPES.includes(eventType)) {
      const error = new Error(`Unsupported observability event type: ${eventType}`);
      error.code = 'INVALID_EVENT_TYPE';
      throw error;
    }
    const createdAt = nowMs(now);
    const usage = extractUsage(input.usage || input.result || input);
    const explicitCost = normalizeInteger(input.costMicros ?? usage.costMicros);
    const costMicros = explicitCost === null && costRate !== null && usage.tokens !== null
      ? Math.floor((usage.tokens / 1000) * costRate)
      : explicitCost;
    const row = {
      eventId: String(input.eventId || crypto.randomUUID()),
      workspaceId,
      runId: String(input.runId || ''),
      traceId: String(input.traceId || ''),
      agentId: String(input.agentId || ''),
      eventType,
      status: String(input.status || ''),
      tool: String(input.tool || ''),
      durationMs: normalizeInteger(input.durationMs),
      tokens: usage.tokens,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costMicros,
      costKnown: costMicros !== null,
      payload: safePayload(input.payload),
      createdAt,
    };
    const event = internal.persistEvent(statements.insertEvent, row, projectEvent);
    publish(event);
    if (evaluate && eventType !== 'alert_firing') evaluateAlerts(workspaceId, event);
    return event;
  }

  function upsertRun(input) {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const runId = String(input.runId || '').trim();
    if (!runId) {
      const error = new Error('runId is required');
      error.code = 'INVALID_RUN_ID';
      throw error;
    }
    const current = statements.getRun.get(workspaceId, runId);
    const timestamp = nowMs(now);
    const startedAt = normalizeInteger(input.startedAt) ?? current?.started_at ?? timestamp;
    const finishedAt = input.finishedAt === null ? null : (normalizeInteger(input.finishedAt) ?? current?.finished_at ?? null);
    const durationMs = normalizeInteger(input.durationMs) ?? (
      finishedAt === null ? (current?.duration_ms ?? null) : Math.max(0, finishedAt - startedAt)
    );
    const usage = extractUsage(input.usage || input.result || input);
    const costMicros = normalizeInteger(input.costMicros ?? usage.costMicros ?? current?.cost_micros);
    const row = {
      runId,
      workspaceId,
      agentId: String(input.agentId ?? current?.agent_id ?? ''),
      runtime: String(input.runtime ?? current?.runtime ?? 'unknown'),
      goalDigest: input.goalDigest || (input.goal ? digestText(input.goal) : (current?.goal_digest || '')),
      goalLength: normalizeInteger(input.goalLength) ?? (input.goal ? String(input.goal).length : Number(current?.goal_length || 0)),
      objective: String(input.objective ?? current?.objective ?? ''),
      status: String(input.status ?? current?.status ?? 'running'),
      startedAt,
      finishedAt,
      durationMs,
      stepCount: normalizeInteger(input.stepCount) ?? Number(current?.step_count || 0),
      successfulSteps: normalizeInteger(input.successfulSteps) ?? Number(current?.successful_steps || 0),
      blockedSteps: normalizeInteger(input.blockedSteps) ?? Number(current?.blocked_steps || 0),
      errorSteps: normalizeInteger(input.errorSteps) ?? Number(current?.error_steps || 0),
      tokens: usage.tokens ?? (current?.tokens === null || current?.tokens === undefined ? null : Number(current.tokens)),
      inputTokens: usage.inputTokens ?? (current?.input_tokens === null || current?.input_tokens === undefined ? null : Number(current.input_tokens)),
      outputTokens: usage.outputTokens ?? (current?.output_tokens === null || current?.output_tokens === undefined ? null : Number(current.output_tokens)),
      costMicros,
      costKnown: costMicros !== null || Boolean(current?.cost_known),
      errorCode: String(input.errorCode ?? current?.error_code ?? ''),
      createdAt: current?.created_at ?? startedAt,
      updatedAt: timestamp,
    };
    statements.upsertRun.run(
      row.runId, row.workspaceId, row.agentId, row.runtime, row.goalDigest, row.goalLength,
      row.objective, row.status, row.startedAt, row.finishedAt, row.durationMs, row.stepCount,
      row.successfulSteps, row.blockedSteps, row.errorSteps, row.tokens, row.inputTokens,
      row.outputTokens, row.costMicros, row.costKnown ? 1 : 0, row.errorCode,
      row.createdAt, row.updatedAt,
    );
    return projectRun({
      run_id: row.runId,
      workspace_id: row.workspaceId,
      agent_id: row.agentId,
      runtime: row.runtime,
      goal_digest: row.goalDigest,
      goal_length: row.goalLength,
      objective: row.objective,
      status: row.status,
      started_at: row.startedAt,
      finished_at: row.finishedAt,
      duration_ms: row.durationMs,
      step_count: row.stepCount,
      successful_steps: row.successfulSteps,
      blocked_steps: row.blockedSteps,
      error_steps: row.errorSteps,
      tokens: row.tokens,
      input_tokens: row.inputTokens,
      output_tokens: row.outputTokens,
      cost_micros: row.costMicros,
      cost_known: row.costKnown ? 1 : 0,
      error_code: row.errorCode,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    });
  }

  function recordRunStart(input) {
    const run = upsertRun({ ...input, status: 'running', startedAt: input.startedAt ?? nowMs(now) });
    insertEvent({ ...input, eventType: 'run_started', status: 'running', runId: run.runId });
    return run;
  }

  function recordRunFinish(input) {
    const run = upsertRun(input);
    const event = insertEvent({ ...input, eventType: 'run_finished', status: run.status, runId: run.runId });
    return { run, event };
  }

  function recordStep(input) {
    return insertEvent({ ...input, eventType: 'step_finished' });
  }

  function recordLifecycle(eventName, data = {}) {
    const state = data.state || data;
    const workspaceId = state.workspaceId || data.workspaceId || 'default';
    const runId = String(state.observabilityRunId || state.runId || state.checkpointId || data.runId || crypto.randomUUID());
    state.observabilityRunId = runId;
    const traceId = String(state.traceId || data.traceId || runId);
    state.traceId = traceId;
    if (eventName === 'beforeAgentRun') {
      return recordRunStart({
        workspaceId,
        runId,
        traceId,
        agentId: state.agentId,
        runtime: data.runtime || state.runtime || 'agent-v3',
        goal: state.goal,
        objective: state.objective,
        startedAt: state.startedAt ? Date.parse(state.startedAt) : nowMs(now),
      });
    }
    if (eventName === 'afterTask') {
      const step = data.step || {};
      return recordStep({
        workspaceId,
        runId,
        traceId: step.traceId || traceId,
        agentId: state.agentId,
        status: step.status,
        tool: step.tool,
        result: step.result || step.output,
        payload: { stepId: step.id || null, action: step.action || null, policyAction: step.policy?.action || null },
      });
    }
    if (eventName === 'afterAgentRun') {
      const steps = Array.isArray(state.steps) ? state.steps : [];
      const usages = steps.map(step => extractUsage(step?.result || step?.output || step));
      const usage = usages.reduce((acc, item) => ({
        tokens: acc.tokens === null || item.tokens === null ? null : acc.tokens + item.tokens,
        inputTokens: acc.inputTokens === null || item.inputTokens === null ? null : acc.inputTokens + item.inputTokens,
        outputTokens: acc.outputTokens === null || item.outputTokens === null ? null : acc.outputTokens + item.outputTokens,
        costMicros: acc.costMicros === null || item.costMicros === null ? null : acc.costMicros + item.costMicros,
      }), { tokens: 0, inputTokens: 0, outputTokens: 0, costMicros: 0 });
      const hasUsage = usages.some(item => item.tokens !== null || item.inputTokens !== null || item.outputTokens !== null || item.costMicros !== null);
      const finishedAt = nowMs(now);
      const startedAt = state.startedAt ? Date.parse(state.startedAt) : finishedAt;
      const successfulSteps = steps.filter(step => ['done', 'completed'].includes(String(step.status))).length;
      const blockedSteps = steps.filter(step => String(step.status) === 'blocked').length;
      const errorSteps = steps.filter(step => ['error', 'failed', 'review'].includes(String(step.status))).length;
      const result = recordRunFinish({
        workspaceId,
        runId,
        traceId,
        agentId: state.agentId,
        runtime: data.runtime || state.runtime || 'agent-v3',
        goal: state.goal,
        objective: state.objective,
        status: state.status || (data.ok === false ? 'failed' : 'completed'),
        startedAt: Number.isFinite(startedAt) ? startedAt : finishedAt,
        finishedAt,
        durationMs: Number.isFinite(startedAt) ? Math.max(0, finishedAt - startedAt) : null,
        stepCount: steps.length,
        successfulSteps,
        blockedSteps,
        errorSteps,
        usage: hasUsage ? usage : {},
        errorCode: state.error?.code || state.blockReason || '',
        payload: { resumed: Boolean(state.resumed), remainingSteps: state.remainingSteps ?? null },
      });
      return result;
    }
    return null;
  }

  function recordGateDecision(input) {
    return insertEvent({ ...input, eventType: 'gate_decision', status: input.decision || input.status });
  }

  function listEvents({ workspaceId, limit, cursor, eventType, runId, windowMs } = {}) {
    const workspace = normalizeWorkspaceId(workspaceId);
    const pageSize = normalizeLimit(limit);
    const decoded = decodePageCursor(cursor);
    const params = [workspace];
    const clauses = ['workspace_id = ?'];
    if (windowMs !== undefined) { clauses.push('created_at >= ?'); params.push(nowMs(now) - Math.min(MAX_METRIC_WINDOW_MS, Math.max(1_000, normalizeInteger(windowMs) ?? 1_000))); }
    if (eventType) { clauses.push('event_type = ?'); params.push(String(eventType)); }
    if (runId) { clauses.push('run_id = ?'); params.push(String(runId)); }
    if (decoded) {
      clauses.push('(created_at < ? OR (created_at = ? AND event_id < ?))');
      params.push(decoded.ts, decoded.ts, decoded.id);
    }
    params.push(pageSize + 1);
    const rows = db.prepare(`SELECT * FROM observability_events WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC, event_id DESC LIMIT ?`).all(...params);
    const hasMore = rows.length > pageSize;
    const page = rows.slice(0, pageSize).map(projectEvent);
    const last = page[page.length - 1];
    return { items: page, limit: pageSize, hasMore, nextCursor: hasMore && last ? cursorEncode({ ts: Date.parse(last.createdAt), id: last.eventId }) : null };
  }

  function listRuns({ workspaceId, limit, cursor, status, windowMs } = {}) {
    const workspace = normalizeWorkspaceId(workspaceId);
    const pageSize = normalizeLimit(limit);
    const decoded = decodePageCursor(cursor);
    const params = [workspace];
    const clauses = ['workspace_id = ?'];
    if (windowMs !== undefined) { clauses.push('updated_at >= ?'); params.push(nowMs(now) - Math.min(MAX_METRIC_WINDOW_MS, Math.max(1_000, normalizeInteger(windowMs) ?? 1_000))); }
    if (status) { clauses.push('status = ?'); params.push(String(status)); }
    if (decoded) {
      clauses.push('(updated_at < ? OR (updated_at = ? AND run_id < ?))');
      params.push(decoded.ts, decoded.ts, decoded.id);
    }
    params.push(pageSize + 1);
    const rows = db.prepare(`SELECT * FROM observability_runs WHERE ${clauses.join(' AND ')}
      ORDER BY updated_at DESC, run_id DESC LIMIT ?`).all(...params);
    const hasMore = rows.length > pageSize;
    const page = rows.slice(0, pageSize).map(row => {
      const run = projectRun(row);
      const tools = statements.listToolsByRun.all(workspace, run.runId).map(tool => ({
        name: tool.tool,
        count: Number(tool.call_count),
      }));
      return { ...run, tools, toolCallCount: tools.reduce((total, tool) => total + tool.count, 0) };
    });
    const last = rows[page.length - 1];
    return { items: page, limit: pageSize, hasMore, nextCursor: hasMore && last ? cursorEncode({ ts: Number(last.updated_at), id: last.run_id }) : null };
  }

  function summary({ workspaceId, windowMs = 24 * 60 * 60 * 1000 } = {}) {
    const readStarted = process.hrtime.bigint();
    const workspace = normalizeWorkspaceId(workspaceId);
    const window = Math.min(MAX_METRIC_WINDOW_MS, Math.max(1_000, normalizeInteger(windowMs) ?? (24 * 60 * 60 * 1000)));
    const since = nowMs(now) - window;
    const aggregate = db.prepare(`SELECT
      COUNT(*) AS total_runs,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_runs,
      SUM(CASE WHEN status IN ('failed', 'blocked', 'partial') THEN 1 ELSE 0 END) AS failed_runs,
      AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms END) AS avg_latency_ms,
      SUM(CASE WHEN tokens IS NOT NULL THEN tokens ELSE 0 END) AS total_tokens,
      SUM(CASE WHEN cost_micros IS NOT NULL THEN cost_micros ELSE 0 END) AS total_cost_micros,
      SUM(CASE WHEN error_steps > 0 OR blocked_steps > 0 OR status IN ('failed', 'blocked') THEN 1 ELSE 0 END) AS error_runs
      FROM observability_runs WHERE workspace_id = ? AND updated_at >= ?`).get(workspace, since);
    const durations = db.prepare(`SELECT duration_ms FROM observability_runs
      WHERE workspace_id = ? AND updated_at >= ? AND duration_ms IS NOT NULL
      ORDER BY duration_ms ASC LIMIT 5000`).all(workspace, since).map(row => Number(row.duration_ms));
    const p95 = durations.length ? durations[Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1)] : null;
    const terminal = Number(aggregate.completed_runs || 0) + Number(aggregate.failed_runs || 0);
    const queueDepth = Number(statements.countQueue.get(workspace)?.count || 0);
    const toolUsage = db.prepare(`SELECT tool, COUNT(*) AS call_count FROM observability_events
      WHERE workspace_id = ? AND event_type = 'step_finished' AND tool <> '' AND created_at >= ?
      GROUP BY tool ORDER BY call_count DESC, tool ASC`).all(workspace, since).map(row => ({
        name: row.tool,
        count: Number(row.call_count),
      }));
    const toolCallCount = toolUsage.reduce((total, tool) => total + tool.count, 0);
    const result = {
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
      tokenKnown: db.prepare(`SELECT COUNT(*) AS count FROM observability_runs
        WHERE workspace_id = ? AND updated_at >= ? AND tokens IS NOT NULL`).get(workspace, since).count > 0,
      totalCostMicros: aggregate.total_cost_micros === null ? null : Number(aggregate.total_cost_micros),
      costKnown: db.prepare(`SELECT COUNT(*) AS count FROM observability_runs
        WHERE workspace_id = ? AND updated_at >= ? AND cost_known = 1`).get(workspace, since).count > 0,
      errorRuns: Number(aggregate.error_runs || 0),
      queueDepth,
      toolUsage,
      toolCallCount,
      generatedAt: new Date(nowMs(now)).toISOString(),
    };
    internal.observe('dbReadMs', Number(process.hrtime.bigint() - readStarted) / 1e6);
    return result;
  }

  function evaluateAlerts(workspaceId, event) {
    const rows = db.prepare(`SELECT * FROM observability_alert_rules
      WHERE workspace_id = ? AND enabled = 1`).all(workspaceId);
    const fired = [];
    for (const row of rows) {
      const rule = projectRule(row);
      const metrics = summary({ workspaceId, windowMs: rule.windowMs });
      const metricMap = {
        success_rate: metrics.successRate,
        avg_latency_ms: metrics.avgLatencyMs,
        p95_latency_ms: metrics.p95LatencyMs,
        token_total: metrics.totalTokens,
        cost_micros: metrics.totalCostMicros,
        error_count: metrics.errorRuns,
        queue_depth: metrics.queueDepth,
      };
      const value = metricMap[rule.metric];
      const previous = statements.getLatestAlert.get(workspaceId, rule.ruleId);
      const breached = value !== null && value !== undefined && compareMetric(value, rule.operator, rule.threshold);
      if (!breached) {
        if (previous && ['firing', 'acknowledged'].includes(previous.status)) {
          const resolvedAt = nowMs(now);
          statements.updateAlertStatus.run('resolved', previous.acknowledged_at, resolvedAt, workspaceId, previous.alert_id);
          const alertEvent = insertEvent({ workspaceId, eventType: 'alert_resolved', status: 'resolved',
            payload: { alertId: previous.alert_id, ruleId: rule.ruleId, metric: rule.metric } }, { evaluate: false });
          const resolved = projectAlert(statements.getAlert.get(workspaceId, previous.alert_id));
          dispatchNotification(resolved, alertEvent.createdAt);
        }
        continue;
      }
      const previousAt = previous ? Number(previous.fired_at) : 0;
      if (previous && ['firing', 'acknowledged'].includes(previous.status)) continue;
      if (previous && nowMs(now) - previousAt < rule.cooldownMs) continue;
      const alertId = crypto.randomUUID();
      const fingerprint = crypto.createHash('sha256').update(`${workspaceId}\0${rule.ruleId}\0${rule.metric}`).digest('hex');
      statements.insertAlert.run(alertId, rule.ruleId, workspaceId, rule.metric, value, rule.threshold, fingerprint, event?.eventId || '', nowMs(now));
      const alertEvent = insertEvent({
        workspaceId,
        eventType: 'alert_firing',
        status: 'firing',
        payload: { alertId, ruleId: rule.ruleId, metric: rule.metric, value, threshold: rule.threshold },
      }, { evaluate: false });
      fired.push(projectAlert({
        alert_id: alertId,
        rule_id: rule.ruleId,
        workspace_id: workspaceId,
        metric: rule.metric,
        value,
        threshold: rule.threshold,
        fingerprint,
        status: 'firing',
        event_id: alertEvent.eventId,
        fired_at: Date.parse(alertEvent.createdAt),
        acknowledged_at: null,
        resolved_at: null,
      }));
      dispatchNotification(fired[fired.length - 1], alertEvent.createdAt);
    }
    return fired;
  }

  function createAlertRule(input) {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const metric = String(input.metric || '');
    const operator = String(input.operator || '');
    if (!ALERT_METRICS.includes(metric) || !ALERT_OPERATORS.includes(operator)) {
      const error = new Error('Unsupported alert metric or operator.');
      error.code = 'INVALID_ALERT_RULE';
      throw error;
    }
    const threshold = normalizeOptionalNumber(input.threshold);
    if (threshold === null) {
      const error = new Error('Alert threshold must be numeric.');
      error.code = 'INVALID_ALERT_RULE';
      throw error;
    }
    const timestamp = nowMs(now);
    const ruleId = String(input.ruleId || crypto.randomUUID());
    statements.insertRule.run(
      ruleId, workspaceId, String(input.name || `${metric} ${operator} ${threshold}`).slice(0, 160),
      metric, operator, threshold,
      Math.min(MAX_METRIC_WINDOW_MS, Math.max(1_000, normalizeInteger(input.windowMs) ?? 300_000)),
      Math.min(MAX_METRIC_WINDOW_MS, Math.max(1_000, normalizeInteger(input.cooldownMs) ?? 900_000)),
      input.enabled === false ? 0 : 1, timestamp, timestamp,
    );
    return projectRule(statements.getRule.get(workspaceId, ruleId));
  }

  function listAlertRules({ workspaceId, limit } = {}) {
    const workspace = normalizeWorkspaceId(workspaceId);
    return statements.getRules.all(workspace, normalizeLimit(limit, 50, MAX_ALERT_LIMIT)).map(projectRule);
  }

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

  function deleteAlertRule({ workspaceId, ruleId } = {}) {
    const workspace = normalizeWorkspaceId(workspaceId);
    return statements.deleteRule.run(workspace, String(ruleId || '')).changes > 0;
  }

  function listAlerts({ workspaceId, limit } = {}) {
    const workspace = normalizeWorkspaceId(workspaceId);
    return statements.listAlerts.all(workspace, normalizeLimit(limit, 50, MAX_ALERT_LIMIT)).map(projectAlert);
  }

  function pageAlerts({ workspaceId, limit, cursor, windowMs } = {}) {
    const workspace = normalizeWorkspaceId(workspaceId);
    const pageSize = normalizeLimit(limit, 50, MAX_ALERT_LIMIT);
    const decoded = decodePageCursor(cursor);
    const params = [workspace];
    const clauses = ['workspace_id = ?'];
    if (windowMs !== undefined) { clauses.push('fired_at >= ?'); params.push(nowMs(now) - Math.min(MAX_METRIC_WINDOW_MS, Math.max(1_000, normalizeInteger(windowMs) ?? 1_000))); }
    if (decoded) {
      clauses.push('(fired_at < ? OR (fired_at = ? AND alert_id < ?))');
      params.push(decoded.ts, decoded.ts, decoded.id);
    }
    params.push(pageSize + 1);
    const rows = db.prepare(`SELECT * FROM observability_alerts WHERE ${clauses.join(' AND ')}
      ORDER BY fired_at DESC, alert_id DESC LIMIT ?`).all(...params);
    return projectPage(rows, pageSize, projectAlert, 'fired_at', 'alert_id');
  }

  function acknowledgeAlert({ workspaceId, alertId } = {}) {
    const workspace = normalizeWorkspaceId(workspaceId);
    const id = String(alertId || '');
    const timestamp = nowMs(now);
    const changed = statements.acknowledgeAlert.run(timestamp, workspace, id).changes > 0;
    if (!changed) return null;
    const alertEvent = insertEvent({ workspaceId: workspace, eventType: 'alert_acknowledged', status: 'acknowledged',
      payload: { alertId: id } }, { evaluate: false });
    const alert = projectAlert(statements.getAlert.get(workspace, id));
    dispatchNotification(alert, alertEvent.createdAt);
    return alert;
  }

  function enqueueJob(input = {}) {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const goal = String(input.goal || '').trim();
    if (!goal || goal.length > 4000) {
      const error = new Error('goal is required and must be at most 4000 characters.');
      error.code = 'INVALID_QUEUE_GOAL';
      throw error;
    }
    const maxSteps = Math.min(8, Math.max(1, normalizeInteger(input.maxSteps) ?? 4));
    const maxAttempts = Math.min(5, Math.max(1, normalizeInteger(input.maxAttempts) ?? 3));
    const timestamp = nowMs(now);
    const jobId = String(input.jobId || crypto.randomUUID());
    statements.insertJob.run(
      jobId, workspaceId, String(input.agentId || ''), goal, maxSteps, maxAttempts,
      timestamp, timestamp, timestamp,
    );
    const job = projectJob(statements.getJob.get(workspaceId, jobId));
    insertEvent({ workspaceId, eventType: 'queue_enqueued', status: 'queued', agentId: input.agentId, payload: { jobId, maxSteps } });
    return job;
  }

  function recoverExpiredJobs() {
    const timestamp = nowMs(now);
    const recover = () => {
      const rows = statements.expiredLeases.all(timestamp);
      let recovered = 0;
      for (const row of rows) {
        const terminal = Number(row.attempts || 0) >= Number(row.max_attempts || 0);
        const status = terminal ? 'dead' : 'queued';
        const changed = statements.recoverLease.run(
          status, timestamp, timestamp, row.job_id, row.lease_until,
        ).changes > 0;
        if (!changed) continue;
        recovered += 1;
        insertEvent({
          workspaceId: row.workspace_id,
          eventType: 'queue_finished',
          status,
          runId: row.run_id,
          agentId: row.agent_id,
          payload: { jobId: row.job_id, retry: !terminal, attempt: Number(row.attempts || 0), errorCode: 'WORKER_LEASE_EXPIRED' },
        });
      }
      return recovered;
    };
    return typeof db.transaction === 'function' ? db.transaction(recover)() : recover();
  }

  function claimNextJob({ workerId, leaseMs = 120000 } = {}) {
    const id = String(workerId || '').trim();
    if (!id) throw new TypeError('workerId is required');
    recoverExpiredJobs();
    const claim = () => {
      const row = statements.nextJob.get(nowMs(now));
      if (!row) return null;
      const timestamp = nowMs(now);
      const leaseUntil = timestamp + Math.min(MAX_METRIC_WINDOW_MS, Math.max(1000, normalizeInteger(leaseMs) ?? 120000));
      const result = statements.claimJob.run(leaseUntil, id, timestamp, row.job_id);
      if (!result.changes) return null;
      const claimed = statements.getJob.get(row.workspace_id, row.job_id);
      const job = { ...projectJob(claimed), goal: row.goal };
      insertEvent({ workspaceId: row.workspace_id, eventType: 'queue_started', status: 'running', runId: row.run_id, agentId: row.agent_id, payload: { jobId: row.job_id, attempt: Number(claimed.attempts || 0) } });
      return job;
    };
    return typeof db.transaction === 'function' ? db.transaction(claim)() : claim();
  }

  function finishJob({ jobId, workspaceId, workerId, status, runId = '', errorCode = '', result = null } = {}) {
    const workspace = normalizeWorkspaceId(workspaceId);
    const validStatus = ['completed', 'failed', 'dead'].includes(String(status)) ? String(status) : 'failed';
    const id = String(jobId || '');
    const worker = String(workerId || '');
    if (!statements.getJob.get(workspace, id)) {
      insertEvent({ workspaceId: workspace, eventType: 'queue_finished', status: 'rejected', payload: { jobId: id, errorCode: 'UNKNOWN_QUEUE_JOB' } });
      return null;
    }
    const safeResult = safePayload({ status: result?.status || validStatus, runId: runId || null });
    const changed = statements.completeJob.run(validStatus, String(runId || ''), JSON.stringify(safeResult), String(errorCode || '').slice(0, 160), nowMs(now), id, worker).changes > 0;
    if (!changed) return null;
    const job = projectJob(statements.getJob.get(workspace, id));
    insertEvent({ workspaceId: workspace, eventType: 'queue_finished', status: validStatus, runId, agentId: job?.agentId, payload: { jobId: id, runId: runId || null, errorCode: errorCode || null } });
    return job;
  }

  function retryJob({ jobId, workspaceId, workerId, delayMs = 1000, errorCode = 'WORKER_RETRY' } = {}) {
    const workspace = normalizeWorkspaceId(workspaceId);
    const id = String(jobId || '');
    const worker = String(workerId || '');
    const job = statements.getJob.get(workspace, id);
    if (!job) {
      insertEvent({ workspaceId: workspace, eventType: 'queue_finished', status: 'rejected', payload: { jobId: id, errorCode: 'UNKNOWN_QUEUE_JOB' } });
      return null;
    }
    if (String(job.worker_id || '') !== worker || job.status !== 'running') return null;
    const terminal = Number(job.attempts || 0) >= Number(job.max_attempts || 0);
    const status = terminal ? 'dead' : 'queued';
    const changed = statements.retryJob.run(status, nowMs(now) + Math.max(0, normalizeInteger(delayMs) ?? 1000), String(errorCode || '').slice(0, 160), nowMs(now), id, worker).changes > 0;
    if (!changed) return null;
    const next = projectJob(statements.getJob.get(workspace, id));
    insertEvent({ workspaceId: workspace, eventType: 'queue_finished', status, agentId: next?.agentId, payload: { jobId: id, retry: !terminal, errorCode: errorCode || null } });
    return next;
  }

  function listQueue({ workspaceId, limit } = {}) {
    const workspace = normalizeWorkspaceId(workspaceId);
    return statements.listJobs.all(workspace, normalizeLimit(limit, 50, MAX_ALERT_LIMIT)).map(projectJob);
  }

  function pageQueue({ workspaceId, limit, cursor, status, windowMs } = {}) {
    const workspace = normalizeWorkspaceId(workspaceId);
    const pageSize = normalizeLimit(limit, 50, MAX_ALERT_LIMIT);
    const decoded = decodePageCursor(cursor);
    const params = [workspace];
    const clauses = ['workspace_id = ?'];
    if (windowMs !== undefined) { clauses.push('updated_at >= ?'); params.push(nowMs(now) - Math.min(MAX_METRIC_WINDOW_MS, Math.max(1_000, normalizeInteger(windowMs) ?? 1_000))); }
    if (status) { clauses.push('status = ?'); params.push(String(status)); }
    if (decoded) {
      clauses.push('(updated_at < ? OR (updated_at = ? AND job_id < ?))');
      params.push(decoded.ts, decoded.ts, decoded.id);
    }
    params.push(pageSize + 1);
    const rows = db.prepare(`SELECT * FROM agent_queue_jobs WHERE ${clauses.join(' AND ')}
      ORDER BY updated_at DESC, job_id DESC LIMIT ?`).all(...params);
    return projectPage(rows, pageSize, projectJob, 'updated_at', 'job_id');
  }

  function queueSummary({ workspaceId } = {}) {
    const workspace = normalizeWorkspaceId(workspaceId);
    const rows = db.prepare(`SELECT status, COUNT(*) AS count FROM agent_queue_jobs
      WHERE workspace_id = ? GROUP BY status`).all(workspace);
    const byStatus = Object.fromEntries(rows.map(row => [row.status, Number(row.count)]));
    const oldest = db.prepare(`SELECT MIN(created_at) AS created_at FROM agent_queue_jobs
      WHERE workspace_id = ? AND status IN ('queued', 'running')`).get(workspace);
    const oldestActiveAt = oldest?.created_at === null || oldest?.created_at === undefined
      ? null
      : new Date(Number(oldest.created_at)).toISOString();
    return {
      workspaceId: workspace,
      byStatus,
      depth: Number((byStatus.queued || 0) + (byStatus.running || 0)),
      oldestActiveAt,
      lagMs: oldestActiveAt === null ? 0 : Math.max(0, nowMs(now) - Number(oldest.created_at)),
    };
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    subscribers.add(listener);
    internal.gauge('subscribers', subscribers.size);
    return () => { subscribers.delete(listener); internal.gauge('subscribers', subscribers.size); };
  }

  function internalMetrics() {
    const oldest = db.prepare(`SELECT MIN(created_at) AS created_at FROM agent_queue_jobs WHERE status = 'queued'`).get()?.created_at;
    internal.gauge('queueLagMs', oldest ? Math.max(0, nowMs(now) - Number(oldest)) : 0);
    return internal.snapshot();
  }

  function recordWorkerHealth({ enabled, busy, failed = false } = {}) {
    internal.gauge('workerEnabled', Boolean(enabled));
    internal.gauge('workerBusy', Boolean(busy));
    internal.workerTick();
    if (failed) internal.increment('workerFailures');
  }

  return {
    acknowledgeAlert,
    createAlertRule,
    deleteAlertRule,
    enqueueJob,
    extractUsage,
    finishJob,
    claimNextJob,
    listAlerts,
    pageAlerts,
    listQueue,
    pageQueue,
    queueSummary,
    recoverExpiredJobs,
    retryJob,
    listAlertRules,
    pageAlertRules,
    listEvents,
    listRuns,
    internalMetrics,
    recordWorkerHealth,
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
