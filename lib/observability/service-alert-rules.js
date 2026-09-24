'use strict';
// #2147: alert rules per workspace, capped at MAX_ALERT_LIMIT, and the alert list.
const crypto = require('node:crypto');
const { normalizeInteger, normalizeLimit, normalizeOptionalNumber, normalizeWorkspaceId, nowMs, projectAlert, projectRule } = require('./helpers');
const { ALERT_METRICS, ALERT_OPERATORS, MAX_ALERT_LIMIT, MAX_METRIC_WINDOW_MS } = require('./service-constants');
function createObservabilityAlertRules({ now, statements }) {
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
    const result = statements.insertRuleIfWithinLimit.run(
      ruleId, workspaceId, String(input.name || `${metric} ${operator} ${threshold}`).slice(0, 160),
      metric, operator, threshold,
      Math.min(MAX_METRIC_WINDOW_MS, Math.max(1_000, normalizeInteger(input.windowMs) ?? 300_000)),
      Math.min(MAX_METRIC_WINDOW_MS, Math.max(1_000, normalizeInteger(input.cooldownMs) ?? 900_000)),
      input.enabled === false ? 0 : 1, timestamp, timestamp,
      workspaceId, MAX_ALERT_LIMIT,
    );
    if (result.changes !== 1) {
      const error = new Error(`Workspace alert rule limit reached (${MAX_ALERT_LIMIT}).`);
      error.code = 'ALERT_RULE_LIMIT_REACHED';
      throw error;
    }
    return projectRule(statements.getRule.get(workspaceId, ruleId));
  }

  function listAlertRules({ workspaceId, limit } = {}) {
    const workspace = normalizeWorkspaceId(workspaceId);
    return statements.getRules.all(workspace, normalizeLimit(limit, 50, MAX_ALERT_LIMIT)).map(projectRule);
  }

  function deleteAlertRule({ workspaceId, ruleId } = {}) {
    const workspace = normalizeWorkspaceId(workspaceId);
    return statements.deleteRule.run(workspace, String(ruleId || '')).changes > 0;
  }

  function listAlerts({ workspaceId, limit } = {}) {
    const workspace = normalizeWorkspaceId(workspaceId);
    return statements.listAlerts.all(workspace, normalizeLimit(limit, 50, MAX_ALERT_LIMIT)).map(projectAlert);
  }
  return { createAlertRule, listAlertRules, deleteAlertRule, listAlerts };
}
module.exports = { createObservabilityAlertRules };
