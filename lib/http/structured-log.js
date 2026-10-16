'use strict';

const crypto = require('node:crypto');
const { scrubSecrets } = require('../secret-scrub-gate');

const MAX_ID_LENGTH = 128;
const SAFE_ID = /^[A-Za-z0-9._:-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOG_LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const SAFE_FIELDS = new Set([
  'route', 'method', 'status', 'errorCode', 'workspaceId', 'agentId', 'runId', 'traceId',
  'durationMs', 'outcome', 'runtime', 'reason',
]);

function normalizeId(value) {
  if (typeof value !== 'string') return '';
  const candidate = value.trim();
  return candidate && candidate.length <= MAX_ID_LENGTH && SAFE_ID.test(candidate) ? candidate : '';
}

function normalizeLogLevel(value, fallback = 'info') {
  const candidate = String(value || '').trim().toLowerCase();
  return Object.hasOwn(LOG_LEVELS, candidate) ? candidate : fallback;
}

function generatedId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function requestUuid(value) {
  const normalized = normalizeId(value);
  if (UUID.test(normalized)) return normalized;
  if (normalized.startsWith('req-') && UUID.test(normalized.slice(4))) return normalized.slice(4);
  return crypto.randomUUID();
}

function createRequestCorrelation(req, res) {
  const context = Object.freeze({
    requestId: generatedId('req'),
    traceId: generatedId('trace'),
  });
  if (req && typeof req === 'object') req.huqanCorrelation = context;
  if (res && typeof res.setHeader === 'function' && !res.headersSent) {
    res.setHeader('X-Request-Id', context.requestId);
  }
  return context;
}

function safeField(key, value) {
  if (!SAFE_FIELDS.has(key)) return undefined;
  if (['requestId', 'agentId', 'runId', 'traceId', 'workspaceId', 'reason'].includes(key)) {
    const normalized = normalizeId(value);
    return normalized || undefined;
  }
  if (key === 'method') {
    const method = normalizeId(value);
    return method && method.length <= 16 ? method.toUpperCase() : undefined;
  }
  if (key === 'status' || key === 'durationMs') {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 && numeric <= 3_600_000 ? Math.floor(numeric) : undefined;
  }
  const text = normalizeId(String(value ?? ''));
  return text || undefined;
}

function configuredLogLevel(env = process.env) {
  return normalizeLogLevel(env?.HUQAN_LOG_LEVEL, 'info');
}

function shouldEmit(level, env = process.env) {
  const normalized = normalizeLogLevel(level, 'info');
  return LOG_LEVELS[normalized] >= LOG_LEVELS[configuredLogLevel(env)];
}

function writeStructuredLog(logger, level, event, context = {}, fields = {}) {
  const normalizedLevel = normalizeLogLevel(level, 'info');
  const requestId = normalizeId(context?.requestId);
  const traceId = normalizeId(context?.traceId);
  const runId = normalizeId(context?.runId);
  const workspaceId = safeField('workspaceId', fields?.workspaceId ?? context?.workspaceId) || 'system';
  const agentId = safeField('agentId', fields?.agentId ?? context?.agentId);
  const reason = safeField(
    'reason',
    fields?.reason ?? fields?.errorCode ?? fields?.outcome ?? 'unspecified',
  ) || 'unspecified';

  const record = {
    event: normalizeId(event).slice(0, 96) || 'http.event',
    reason,
    request_id: requestUuid(requestId),
    timestamp: new Date().toISOString(),
    workspace_id: workspaceId,
    level: normalizedLevel,
  };
  if (agentId) record.agent_id = agentId;

  // Compatibility aliases are retained for existing local consumers while the
  // O4 canonical fields above stay stable and machine-readable.
  if (requestId) record.requestId = requestId;
  if (traceId) record.traceId = traceId;
  if (runId) record.runId = runId;
  if (workspaceId) record.workspaceId = workspaceId;
  if (agentId) record.agentId = agentId;

  for (const key of SAFE_FIELDS) {
    const value = safeField(key, fields?.[key]);
    if (value !== undefined && record[key] === undefined) record[key] = value;
  }

  const scrubbed = scrubSecrets(record).scrubbed;
  const line = JSON.stringify(scrubbed);
  try {
    if (shouldEmit(normalizedLevel) && logger && typeof logger[normalizedLevel] === 'function') {
      logger[normalizedLevel](line);
    }
  } catch (_) {
    // Logging must never change the request, worker, or fail-closed decision path.
  }
  return scrubbed;
}

module.exports = {
  createRequestCorrelation,
  normalizeId,
  shouldEmit,
  writeStructuredLog,
};
