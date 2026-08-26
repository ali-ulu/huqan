const crypto = require('node:crypto');

const MAX_ID_LENGTH = 128;
const SAFE_ID = /^[A-Za-z0-9._:-]+$/;
const SAFE_FIELDS = new Set([
  'route', 'method', 'status', 'errorCode', 'workspaceId', 'runId', 'traceId',
  'durationMs', 'outcome', 'runtime',
]);

function normalizeId(value) {
  if (typeof value !== 'string') return '';
  const candidate = value.trim();
  return candidate && candidate.length <= MAX_ID_LENGTH && SAFE_ID.test(candidate) ? candidate : '';
}

function generatedId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
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
  if (['requestId', 'runId', 'traceId', 'workspaceId'].includes(key)) {
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

function writeStructuredLog(logger, level, event, context = {}, fields = {}) {
  const record = { event: normalizeId(event).slice(0, 96) || 'http.event' };
  const requestId = normalizeId(context?.requestId);
  const traceId = normalizeId(context?.traceId);
  const runId = normalizeId(context?.runId);
  if (requestId) record.requestId = requestId;
  if (traceId) record.traceId = traceId;
  if (runId) record.runId = runId;
  for (const key of SAFE_FIELDS) {
    const value = safeField(key, fields?.[key]);
    if (value !== undefined && record[key] === undefined) record[key] = value;
  }
  const line = JSON.stringify(record);
  try {
    if (logger && typeof logger[level] === 'function') logger[level](line);
  } catch (_) {
    // Logging must never change the request, worker, or fail-closed decision path.
  }
  return record;
}

module.exports = { createRequestCorrelation, normalizeId, writeStructuredLog };
