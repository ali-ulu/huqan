'use strict';
// #2147: writing one observability event -- validation, cost, the row, the
// projection -- then fanning it out to subscribers and alert evaluation.
const crypto = require('node:crypto');
const { extractUsage, normalizeInteger, normalizeWorkspaceId, nowMs, clone, projectEvent, safePayload } = require('./helpers');
const { EVENT_TYPES } = require('./service-constants');
/**
 * `alertLifecycle` is read at call time, not at creation: the lifecycle is
 * built after this recorder because it writes its own events through
 * `insertEvent`.
 */
function createObservabilityEvents({ now, statements, costRate, internalMetrics, subscribers, alertLifecycle }) {
  function publish(event) {
    for (const subscriber of subscribers) {
      if (subscriber.workspaceId && subscriber.workspaceId !== event.workspaceId) continue;
      try { subscriber.listener(clone(event)); } catch (_) { internalMetrics.recordDroppedEvent(event.workspaceId); }
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
    internalMetrics.recordEventWriteAttempt(workspaceId);
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
    try {
      internalMetrics.measureDatabase(workspaceId, () => statements.insertEvent.run(
        row.eventId, row.workspaceId, row.runId, row.traceId, row.agentId, row.eventType,
        row.status, row.tool, row.durationMs, row.tokens, row.inputTokens, row.outputTokens,
        row.costMicros, row.costKnown ? 1 : 0, JSON.stringify(row.payload), row.createdAt,
      ));
      internalMetrics.recordEventWriteSuccess(workspaceId);
    } catch (error) {
      internalMetrics.recordEventWriteFailure(workspaceId);
      throw error;
    }
    let event;
    try {
      event = projectEvent({
        event_id: row.eventId,
        workspace_id: row.workspaceId,
        run_id: row.runId,
        trace_id: row.traceId,
        agent_id: row.agentId,
        event_type: row.eventType,
        status: row.status,
        tool: row.tool,
        duration_ms: row.durationMs,
        tokens: row.tokens,
        input_tokens: row.inputTokens,
        output_tokens: row.outputTokens,
        cost_micros: row.costMicros,
        cost_known: row.costKnown ? 1 : 0,
        payload_json: JSON.stringify(row.payload),
        created_at: row.createdAt,
      });
    } catch (error) {
      internalMetrics.recordProjectionFailure(workspaceId);
      throw error;
    }
    publish(event);
    if (evaluate && eventType !== 'alert_firing') {
      const finishAlertEvaluation = internalMetrics.startAlertEvaluation(workspaceId);
      try { alertLifecycle.evaluateAlerts(workspaceId, event); }
      catch (error) { finishAlertEvaluation({ failed: true }); throw error; }
      finally { finishAlertEvaluation(); }
    }
    return event;
  }
  return { publish, insertEvent };
}
module.exports = { createObservabilityEvents };
