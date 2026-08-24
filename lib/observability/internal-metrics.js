'use strict';

const COUNTERS = new Set(['eventWrites', 'eventWriteFailures', 'projectionFailures', 'subscriberDrops', 'workerTicks', 'workerFailures']);

function createInternalMetrics({ now = Date.now, logger = console } = {}) {
  const counters = Object.fromEntries([...COUNTERS].map(name => [name, 0]));
  const gauges = { subscribers: 0, queueLagMs: 0, workerBusy: false, workerEnabled: false };
  const latency = { eventWriteMs: 0, dbReadMs: 0 };
  let lastEventWriteAt = null;
  let lastWorkerTickAt = null;

  function increment(name) {
    if (!COUNTERS.has(name)) throw new TypeError(`unknown internal counter: ${name}`);
    counters[name] += 1;
  }
  function gauge(name, value) { if (!(name in gauges)) throw new TypeError(`unknown internal gauge: ${name}`); gauges[name] = value; }
  function observe(name, value) { if (!(name in latency)) throw new TypeError(`unknown internal latency: ${name}`); latency[name] = Math.max(0, Number(value) || 0); }
  function eventWritten() { increment('eventWrites'); lastEventWriteAt = new Date(Number(now())).toISOString(); }
  function persistEvent(statement, row, projector) {
    const started = process.hrtime.bigint();
    try {
      statement.run(row.eventId, row.workspaceId, row.runId, row.traceId, row.agentId, row.eventType,
        row.status, row.tool, row.durationMs, row.tokens, row.inputTokens, row.outputTokens,
        row.costMicros, row.costKnown ? 1 : 0, JSON.stringify(row.payload), row.createdAt);
      eventWritten();
    } catch (error) {
      increment('eventWriteFailures');
      logger?.error?.('[observability-internal] event write failed', { code: error?.code || 'OBSERVABILITY_EVENT_WRITE_FAILED', workspaceId: row.workspaceId, runId: row.runId, traceId: row.traceId, eventType: row.eventType });
      throw error;
    } finally { observe('eventWriteMs', Number(process.hrtime.bigint() - started) / 1e6); }
    try {
      return projector({ event_id: row.eventId, workspace_id: row.workspaceId, run_id: row.runId,
        trace_id: row.traceId, agent_id: row.agentId, event_type: row.eventType, status: row.status,
        tool: row.tool, duration_ms: row.durationMs, tokens: row.tokens, input_tokens: row.inputTokens,
        output_tokens: row.outputTokens, cost_micros: row.costMicros, cost_known: row.costKnown ? 1 : 0,
        payload_json: JSON.stringify(row.payload), created_at: row.createdAt });
    } catch (error) {
      increment('projectionFailures');
      logger?.error?.('[observability-internal] event projection failed', { code: error?.code || 'OBSERVABILITY_PROJECTION_FAILED', workspaceId: row.workspaceId, runId: row.runId, traceId: row.traceId, eventType: row.eventType });
      throw error;
    }
  }
  function workerTick() { increment('workerTicks'); lastWorkerTickAt = new Date(Number(now())).toISOString(); }
  function snapshot() {
    return Object.freeze({ counters: { ...counters }, gauges: { ...gauges }, latencyMs: { ...latency }, lastEventWriteAt, lastWorkerTickAt, generatedAt: new Date(Number(now())).toISOString() });
  }
  return { gauge, increment, observe, persistEvent, snapshot, workerTick };
}

module.exports = { createInternalMetrics };
