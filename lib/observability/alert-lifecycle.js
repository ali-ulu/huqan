'use strict';

const crypto = require('node:crypto');
const {
  compareMetric,
  digestText,
  normalizeWorkspaceId,
  nowMs,
  projectAlert,
  projectRule,
} = require('./helpers');

function alertFingerprint(workspaceId, ruleId, metric) {
  return digestText(`${workspaceId}\u0000${ruleId}\u0000${metric}`);
}

function createAlertLifecycle({ statements, insertEvent, summary, now = Date.now } = {}) {
  if (!statements || typeof insertEvent !== 'function' || typeof summary !== 'function') {
    throw new TypeError('alert lifecycle dependencies are required');
  }

  function transitionAlert(row, status, reason) {
    const timestamp = nowMs(now);
    const updated = status === 'acknowledged'
      ? statements.acknowledgeAlert.run(row.workspace_id, row.alert_id)
      : statements.resolveAlert.run(timestamp, row.workspace_id, row.alert_id);
    if (!updated.changes) return null;
    const eventType = status === 'acknowledged' ? 'alert_acknowledged' : 'alert_resolved';
    insertEvent({
      workspaceId: row.workspace_id,
      eventType,
      status,
      payload: {
        alertId: row.alert_id,
        ruleId: row.rule_id,
        metric: row.metric,
        fingerprint: alertFingerprint(row.workspace_id, row.rule_id, row.metric),
        reason: String(reason || 'operator'),
      },
    }, { evaluate: false });
    return projectAlert({
      ...row,
      status,
      resolved_at: status === 'resolved' ? timestamp : row.resolved_at,
    });
  }

  function evaluateAlerts(workspaceId, event) {
    const rows = statements.getEnabledRules.all(workspaceId, 100);
    const fired = [];
    const summaries = new Map();
    for (const row of rows) {
      const rule = projectRule(row);
      const windowKey = String(rule.windowMs);
      if (!summaries.has(windowKey)) summaries.set(windowKey, summary({ workspaceId, windowMs: rule.windowMs }));
      const metrics = summaries.get(windowKey);
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
      if (value === null || value === undefined) continue;
      const active = statements.listActiveAlerts.all(workspaceId, rule.ruleId);
      if (!compareMetric(value, rule.operator, rule.threshold)) {
        for (const alert of active) transitionAlert(alert, 'resolved', 'threshold_recovered');
        continue;
      }
      if (active.length) continue;
      const previous = statements.getLatestAlert.get(workspaceId, rule.ruleId);
      const previousAt = previous ? Number(previous.fired_at) : 0;
      if (previous && nowMs(now) - previousAt < rule.cooldownMs) continue;
      const alertId = crypto.randomUUID();
      statements.insertAlert.run(alertId, rule.ruleId, workspaceId, rule.metric, value, rule.threshold, event?.eventId || '', nowMs(now));
      const alertEvent = insertEvent({
        workspaceId,
        eventType: 'alert_firing',
        status: 'firing',
        payload: {
          alertId,
          ruleId: rule.ruleId,
          metric: rule.metric,
          value,
          threshold: rule.threshold,
          fingerprint: alertFingerprint(workspaceId, rule.ruleId, rule.metric),
        },
      }, { evaluate: false });
      fired.push(projectAlert({
        alert_id: alertId,
        rule_id: rule.ruleId,
        workspace_id: workspaceId,
        metric: rule.metric,
        value,
        threshold: rule.threshold,
        status: 'firing',
        event_id: alertEvent.eventId,
        fired_at: Date.parse(alertEvent.createdAt),
        resolved_at: null,
      }));
    }
    return fired;
  }

  function acknowledgeAlert({ workspaceId, alertId, reason = 'operator' } = {}) {
    const workspace = normalizeWorkspaceId(workspaceId);
    const row = statements.getAlert.get(workspace, String(alertId || ''));
    return row ? transitionAlert(row, 'acknowledged', reason) : null;
  }

  function resolveAlert({ workspaceId, alertId, reason = 'operator' } = {}) {
    const workspace = normalizeWorkspaceId(workspaceId);
    const row = statements.getAlert.get(workspace, String(alertId || ''));
    return row ? transitionAlert(row, 'resolved', reason) : null;
  }

  return { acknowledgeAlert, evaluateAlerts, resolveAlert };
}

module.exports = { alertFingerprint, createAlertLifecycle };
