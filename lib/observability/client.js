'use strict';

const crypto = require('node:crypto');
const FORBIDDEN = /^(goal|prompt|input|output|secret|credential|authorization|api[-_]?key|token)$/i;

function cleanId(value, name) {
  const result = String(value || '').trim();
  if (!result || result.length > 160 || /[\x00-\x1f\x7f]/.test(result)) throw new TypeError(`${name} is required and must be a bounded printable identifier`);
  return result;
}

function safeMetadata(value, depth = 0) {
  if (value === null || value === undefined || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (depth >= 3 || Array.isArray(value)) return undefined;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN.test(key)) throw Object.assign(new TypeError(`sensitive telemetry field rejected: ${key}`), { code: 'SENSITIVE_TELEMETRY_FIELD' });
    const safe = safeMetadata(item, depth + 1);
    if (safe !== undefined) result[key.slice(0, 80)] = safe;
    if (Object.keys(result).length >= 32) break;
  }
  return result;
}

function createTelemetryClient({ sink, workspaceId, agentId = '', runtime = 'external-agent', idFactory = crypto.randomUUID } = {}) {
  if (!sink || typeof sink.recordLifecycle !== 'function') throw new TypeError('telemetry sink with recordLifecycle is required');
  const workspace = cleanId(workspaceId, 'workspaceId');
  const agent = agentId ? cleanId(agentId, 'agentId') : '';
  function context({ runId, traceId } = {}) { return { workspaceId: workspace, runId: cleanId(runId, 'runId'), traceId: cleanId(traceId, 'traceId'), agentId: agent, runtime }; }
  function startRun({ runId = idFactory(), traceId = idFactory(), metadata = {} } = {}) {
    const ids = context({ runId, traceId });
    sink.recordLifecycle('run_started', { ...ids, payload: safeMetadata(metadata) });
    return Object.freeze({ runId: ids.runId, traceId: ids.traceId, workspaceId: workspace });
  }
  function record(eventName, ids, fields = {}) {
    const allowed = safeMetadata(fields);
    return sink.recordLifecycle(eventName, { ...context(ids), ...allowed, payload: safeMetadata(fields.metadata || {}) });
  }
  return Object.freeze({
    startRun,
    finishRun: (ids, fields) => record('run_finished', ids, fields),
    startStep: (ids, fields) => record('step_started', ids, fields),
    finishStep: (ids, fields) => record('step_finished', ids, fields),
    gateDecision: (ids, fields) => record('gate_decision', ids, fields),
  });
}

module.exports = { createTelemetryClient, safeMetadata };
