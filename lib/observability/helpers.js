'use strict';

const crypto = require('node:crypto');
const { normalizeWorkspaceId: normalizeCanonicalWorkspaceId } = require('../workspace-id');

const MAX_EVENT_PAYLOAD_BYTES = 8 * 1024;
const MAX_QUERY_LIMIT = 200;

const normalizeWorkspaceId = (value) => normalizeCanonicalWorkspaceId(value, {
  required: true,
  errorCode: 'INVALID_WORKSPACE_ID',
  errorMessage: 'workspaceId is required and must be at most 128 characters.',
});

function normalizeLimit(value, fallback = 50, max = MAX_QUERY_LIMIT) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(numeric)));
}

function normalizeOptionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeInteger(value) {
  const numeric = normalizeOptionalNumber(value);
  return numeric === null ? null : Math.max(0, Math.floor(numeric));
}

function digestText(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function nowMs(now) {
  const value = typeof now === 'function' ? now() : Date.now();
  return Number.isFinite(Number(value)) ? Number(value) : Date.now();
}

function cursorEncode(value) {
  if (!value) return null;
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function cursorDecode(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (!parsed || !Number.isFinite(Number(parsed.ts)) || typeof parsed.id !== 'string') return null;
    return { ts: Number(parsed.ts), id: parsed.id };
  } catch (_) {
    return null;
  }
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

const SENSITIVE_KEY_WORDS = new Set([
  'goal', 'prompt', 'input', 'output', 'text', 'content',
  'secret', 'token', 'key', 'authorization',
]);

/**
 * Whether a payload key names sensitive data.
 *
 * Matched per word rather than per substring. The substring form dropped any
 * key that merely *contained* one of these strings, so legitimate telemetry
 * disappeared without a trace: `monkey`, `hockey` and `keyboard` on `key`,
 * `texture` on `text`, `tokenizer` on `token`.
 *
 * Word-splitting, not exact-key matching: `apiKey`, `access_token`,
 * `userPrompt` and `secretValue` must all still be redacted, and an exact-key
 * Set would pass every one of them through. A compound like `contentType` is
 * therefore still redacted -- on a redaction gate, an over-cautious drop is the
 * cheaper mistake.
 *
 * @param {string} key
 * @returns {boolean}
 */
function isSensitiveKey(key) {
  return String(key)
    .split(/(?<=[a-z0-9])(?=[A-Z])|[_\W]+/)
    .some(word => SENSITIVE_KEY_WORDS.has(word.toLowerCase()));
}

function safePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  const output = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) continue;
    if (isSensitiveKey(key)) continue;
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      output[key] = typeof value === 'string' ? value.slice(0, 512) : value;
    } else if (Array.isArray(value)) {
      output[key] = value.slice(0, 20).map(item => (
        item === null || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
          ? (typeof item === 'string' ? item.slice(0, 256) : item)
          : undefined
      )).filter(item => item !== undefined);
    }
  }
  const serialized = JSON.stringify(output);
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_EVENT_PAYLOAD_BYTES) return output;
  return { truncated: true };
}

function extractUsage(value) {
  const candidates = [
    value,
    value?.data,
    value?.usage,
    value?.data?.usage,
    value?.meta?.usage,
  ];
  let tokens = null;
  let inputTokens = null;
  let outputTokens = null;
  let costMicros = null;
  let model = '';
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    tokens ??= normalizeInteger(candidate.tokens ?? candidate.total_tokens ?? candidate.totalTokens);
    inputTokens ??= normalizeInteger(candidate.input_tokens ?? candidate.inputTokens ?? candidate.prompt_tokens ?? candidate.promptTokens);
    outputTokens ??= normalizeInteger(candidate.output_tokens ?? candidate.outputTokens ?? candidate.completion_tokens ?? candidate.completionTokens);
    costMicros ??= normalizeInteger(candidate.cost_micros ?? candidate.costMicros);
    model ||= typeof candidate.model === 'string' ? candidate.model.slice(0, 128) : '';
  }
  if (tokens === null && inputTokens !== null && outputTokens !== null) tokens = inputTokens + outputTokens;
  return { tokens, inputTokens, outputTokens, costMicros, model };
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function projectEvent(row) {
  if (!row) return null;
  return {
    eventId: row.event_id,
    workspaceId: row.workspace_id,
    runId: row.run_id || null,
    traceId: row.trace_id || null,
    agentId: row.agent_id || null,
    eventType: row.event_type,
    status: row.status || null,
    tool: row.tool || null,
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    tokens: row.tokens === null ? null : Number(row.tokens),
    inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
    outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
    costMicros: row.cost_micros === null ? null : Number(row.cost_micros),
    costKnown: Boolean(row.cost_known),
    payload: parseJson(row.payload_json, {}),
    createdAt: new Date(Number(row.created_at)).toISOString(),
  };
}

function projectRun(row) {
  if (!row) return null;
  return {
    runId: row.run_id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id || null,
    runtime: row.runtime,
    goalDigest: row.goal_digest || null,
    goalLength: Number(row.goal_length || 0),
    objective: row.objective || null,
    status: row.status,
    startedAt: new Date(Number(row.started_at)).toISOString(),
    finishedAt: row.finished_at === null ? null : new Date(Number(row.finished_at)).toISOString(),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    stepCount: Number(row.step_count || 0),
    successfulSteps: Number(row.successful_steps || 0),
    blockedSteps: Number(row.blocked_steps || 0),
    errorSteps: Number(row.error_steps || 0),
    tokens: row.tokens === null ? null : Number(row.tokens),
    inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
    outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
    costMicros: row.cost_micros === null ? null : Number(row.cost_micros),
    costKnown: Boolean(row.cost_known),
    errorCode: row.error_code || null,
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
  };
}

function projectRule(row) {
  if (!row) return null;
  return {
    ruleId: row.rule_id,
    workspaceId: row.workspace_id,
    name: row.name,
    metric: row.metric,
    operator: row.operator,
    threshold: Number(row.threshold),
    fingerprint: row.fingerprint || null,
    windowMs: Number(row.window_ms),
    cooldownMs: Number(row.cooldown_ms),
    enabled: Boolean(row.enabled),
    createdAt: new Date(Number(row.created_at)).toISOString(),
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
  };
}

function projectAlert(row) {
  if (!row) return null;
  return {
    alertId: row.alert_id,
    ruleId: row.rule_id,
    workspaceId: row.workspace_id,
    metric: row.metric,
    value: Number(row.value),
    threshold: Number(row.threshold),
    fingerprint: row.fingerprint || null,
    status: row.status,
    eventId: row.event_id || null,
    firedAt: new Date(Number(row.fired_at)).toISOString(),
    acknowledgedAt: row.acknowledged_at === null || row.acknowledged_at === undefined ? null : new Date(Number(row.acknowledged_at)).toISOString(),
    resolvedAt: row.resolved_at === null ? null : new Date(Number(row.resolved_at)).toISOString(),
  };
}

function projectJob(row) {
  if (!row) return null;
  return {
    jobId: row.job_id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id || null,
    goalDigest: digestText(row.goal),
    goalLength: String(row.goal || '').length,
    maxSteps: Number(row.max_steps || 0),
    status: row.status,
    attempts: Number(row.attempts || 0),
    maxAttempts: Number(row.max_attempts || 0),
    availableAt: new Date(Number(row.available_at)).toISOString(),
    leaseUntil: row.lease_until === null ? null : new Date(Number(row.lease_until)).toISOString(),
    workerId: row.worker_id || null,
    runId: row.run_id || null,
    errorCode: row.error_code || null,
    createdAt: new Date(Number(row.created_at)).toISOString(),
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
  };
}

function compareMetric(value, operator, threshold) {
  switch (operator) {
    case 'gt': return value > threshold;
    case 'gte': return value >= threshold;
    case 'lt': return value < threshold;
    case 'lte': return value <= threshold;
    case 'eq': return value === threshold;
    default: return false;
  }
}

module.exports = {
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
};
