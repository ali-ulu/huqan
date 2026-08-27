'use strict';

const {
  digestText,
  extractUsage,
  normalizeWorkspaceId,
  safePayload,
} = require('./helpers');

const TELEMETRY_EVENT_TYPES = Object.freeze([
  'run_started',
  'step_finished',
  'gate_decision',
  'run_finished',
]);

const OBSERVABILITY_CLIENT_ERRORS = Object.freeze({
  SERVICE_REQUIRED: 'OBSERVABILITY_CLIENT_SERVICE_REQUIRED',
  WORKSPACE_REQUIRED: 'OBSERVABILITY_CLIENT_WORKSPACE_REQUIRED',
  WORKSPACE_SCOPE_MISMATCH: 'OBSERVABILITY_CLIENT_WORKSPACE_SCOPE_MISMATCH',
  RUN_ID_REQUIRED: 'OBSERVABILITY_CLIENT_RUN_ID_REQUIRED',
  TRACE_ID_INVALID: 'OBSERVABILITY_CLIENT_TRACE_ID_INVALID',
  GOAL_REQUIRED: 'OBSERVABILITY_CLIENT_GOAL_REQUIRED',
  GOAL_DIGEST_INVALID: 'OBSERVABILITY_CLIENT_GOAL_DIGEST_INVALID',
  STATUS_REQUIRED: 'OBSERVABILITY_CLIENT_STATUS_REQUIRED',
  DECISION_REQUIRED: 'OBSERVABILITY_CLIENT_DECISION_REQUIRED',
  VALUE_INVALID: 'OBSERVABILITY_CLIENT_VALUE_INVALID',
});

const HEX_DIGEST = /^[a-f0-9]{64}$/;
const CONTROL_CHARS = /[\x00-\x1F\x7F]/;
const SERVICE_METHODS = Object.freeze([
  'recordRunStart',
  'recordStep',
  'recordGateDecision',
  'recordRunFinish',
]);

function clientError(code, message, details = {}) {
  const error = new TypeError(message);
  error.code = code;
  error.details = { ...details };
  throw error;
}

function normalizeBoundedString(value, field, { required = false, maxLength = 128, code } = {}) {
  if (value === undefined || value === null) {
    if (required) clientError(code, `${field} is required.`, { field });
    return '';
  }
  if (typeof value !== 'string') {
    clientError(code, `${field} must be a string.`, { field });
  }
  const normalized = value.trim();
  if (!normalized && required) clientError(code, `${field} is required.`, { field });
  if (normalized.length > maxLength || CONTROL_CHARS.test(normalized)) {
    clientError(code, `${field} is invalid.`, { field });
  }
  return normalized;
}

function normalizeRunId(value) {
  return normalizeBoundedString(value, 'runId', {
    required: true,
    code: OBSERVABILITY_CLIENT_ERRORS.RUN_ID_REQUIRED,
  });
}

function normalizeTraceId(value, runId) {
  const traceId = value === undefined || value === null || value === '' ? runId : value;
  return normalizeBoundedString(traceId, 'traceId', {
    required: true,
    code: OBSERVABILITY_CLIENT_ERRORS.TRACE_ID_INVALID,
  });
}

function normalizeNonNegativeInteger(value, field, { max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === '') return null;
  if ((typeof value !== 'number' && typeof value !== 'string') || !Number.isFinite(Number(value))) {
    clientError(OBSERVABILITY_CLIENT_ERRORS.VALUE_INVALID, `${field} must be a finite non-negative integer.`, { field });
  }
  const numeric = Number(value);
  if (!Number.isSafeInteger(Math.floor(numeric)) || numeric < 0 || numeric > max) {
    clientError(OBSERVABILITY_CLIENT_ERRORS.VALUE_INVALID, `${field} must be a finite non-negative integer.`, { field });
  }
  return Math.floor(numeric);
}

function normalizeGoal(input, { required = false } = {}) {
  const hasGoal = Object.prototype.hasOwnProperty.call(input, 'goal');
  const hasDigest = Object.prototype.hasOwnProperty.call(input, 'goalDigest');
  if (hasGoal) {
    if (typeof input.goal !== 'string' || !input.goal.trim()) {
      clientError(OBSERVABILITY_CLIENT_ERRORS.GOAL_REQUIRED, 'goal must be a non-empty string.', { field: 'goal' });
    }
    return {
      goalDigest: digestText(input.goal),
      goalLength: input.goal.length,
    };
  }
  if (hasDigest) {
    if (typeof input.goalDigest !== 'string' || !HEX_DIGEST.test(input.goalDigest)) {
      clientError(OBSERVABILITY_CLIENT_ERRORS.GOAL_DIGEST_INVALID, 'goalDigest must be a lowercase SHA-256 digest.', { field: 'goalDigest' });
    }
    return {
      goalDigest: input.goalDigest,
      goalLength: normalizeNonNegativeInteger(input.goalLength, 'goalLength', { max: 4000 }) ?? 0,
    };
  }
  if (required) clientError(OBSERVABILITY_CLIENT_ERRORS.GOAL_REQUIRED, 'goal or goalDigest is required.', { field: 'goal' });
  return {};
}

function normalizeWorkspaceScope(input, workspaceId) {
  if (!Object.prototype.hasOwnProperty.call(input, 'workspaceId')) return;
  if (typeof input.workspaceId !== 'string' || input.workspaceId !== workspaceId) {
    clientError(
      OBSERVABILITY_CLIENT_ERRORS.WORKSPACE_SCOPE_MISMATCH,
      'workspaceId must match the client workspace scope exactly.',
      { workspaceId },
    );
  }
}

function normalizeUsage(value) {
  if (value === undefined || value === null) return undefined;
  const usage = extractUsage(value);
  const normalized = {};
  for (const [key, field] of [
    ['tokens', 'tokens'],
    ['inputTokens', 'inputTokens'],
    ['outputTokens', 'outputTokens'],
    ['costMicros', 'costMicros'],
  ]) {
    if (usage[field] !== null && usage[field] !== undefined) {
      normalized[key] = normalizeNonNegativeInteger(usage[field], key);
    }
  }
  return Object.keys(normalized).length ? normalized : undefined;
}

function normalizeContextValue(input, key, fallback, options = {}) {
  const value = Object.prototype.hasOwnProperty.call(input, key) ? input[key] : fallback;
  return normalizeBoundedString(value, key, options);
}

function createObservabilityTelemetryClient({ service, workspaceId, agentId = '', runtime = 'agent-v3' } = {}) {
  if (!service || typeof service !== 'object' || SERVICE_METHODS.some(method => typeof service[method] !== 'function')) {
    clientError(OBSERVABILITY_CLIENT_ERRORS.SERVICE_REQUIRED, 'observability service with the telemetry methods is required.');
  }
  let scopedWorkspaceId;
  try {
    scopedWorkspaceId = normalizeWorkspaceId(workspaceId, {
      required: true,
      errorCode: OBSERVABILITY_CLIENT_ERRORS.WORKSPACE_REQUIRED,
      errorMessage: 'workspaceId is required for the telemetry client.',
    });
  } catch (error) {
    if (error?.code === OBSERVABILITY_CLIENT_ERRORS.WORKSPACE_REQUIRED) throw error;
    clientError(OBSERVABILITY_CLIENT_ERRORS.WORKSPACE_REQUIRED, 'workspaceId is required for the telemetry client.');
  }
  const scopedAgentId = normalizeContextValue({ agentId }, 'agentId', '', { maxLength: 128, code: OBSERVABILITY_CLIENT_ERRORS.VALUE_INVALID });
  const scopedRuntime = normalizeContextValue({ runtime }, 'runtime', 'agent-v3', { required: true, maxLength: 128, code: OBSERVABILITY_CLIENT_ERRORS.VALUE_INVALID });

  function context(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      clientError(OBSERVABILITY_CLIENT_ERRORS.VALUE_INVALID, 'telemetry input must be an object.');
    }
    normalizeWorkspaceScope(input, scopedWorkspaceId);
    const runId = normalizeRunId(input.runId);
    return {
      workspaceId: scopedWorkspaceId,
      runId,
      traceId: normalizeTraceId(input.traceId, runId),
      agentId: normalizeContextValue(input, 'agentId', scopedAgentId, { maxLength: 128, code: OBSERVABILITY_CLIENT_ERRORS.VALUE_INVALID }),
      runtime: normalizeContextValue(input, 'runtime', scopedRuntime, { required: true, maxLength: 128, code: OBSERVABILITY_CLIENT_ERRORS.VALUE_INVALID }),
    };
  }

  function startRun(input = {}) {
    const base = context(input);
    const goal = normalizeGoal(input, { required: true });
    return service.recordRunStart({
      ...base,
      ...goal,
      startedAt: normalizeNonNegativeInteger(input.startedAt, 'startedAt'),
    });
  }

  function recordStep(input = {}) {
    const base = context(input);
    const status = normalizeBoundedString(input.status, 'status', {
      required: true,
      maxLength: 64,
      code: OBSERVABILITY_CLIENT_ERRORS.STATUS_REQUIRED,
    });
    return service.recordStep({
      ...base,
      status,
      tool: normalizeContextValue(input, 'tool', '', { maxLength: 128, code: OBSERVABILITY_CLIENT_ERRORS.VALUE_INVALID }),
      durationMs: normalizeNonNegativeInteger(input.durationMs, 'durationMs'),
      usage: normalizeUsage(input.usage),
      payload: safePayload(input.payload),
    });
  }

  function recordGateDecision(input = {}) {
    const base = context(input);
    const decision = normalizeBoundedString(input.decision ?? input.status, 'decision', {
      required: true,
      maxLength: 64,
      code: OBSERVABILITY_CLIENT_ERRORS.DECISION_REQUIRED,
    });
    return service.recordGateDecision({
      ...base,
      decision,
      status: decision,
      payload: safePayload(input.payload),
    });
  }

  function finishRun(input = {}) {
    const base = context(input);
    const goal = normalizeGoal(input);
    const status = normalizeBoundedString(input.status, 'status', {
      required: true,
      maxLength: 64,
      code: OBSERVABILITY_CLIENT_ERRORS.STATUS_REQUIRED,
    });
    return service.recordRunFinish({
      ...base,
      ...goal,
      status,
      startedAt: normalizeNonNegativeInteger(input.startedAt, 'startedAt'),
      finishedAt: normalizeNonNegativeInteger(input.finishedAt, 'finishedAt'),
      durationMs: normalizeNonNegativeInteger(input.durationMs, 'durationMs'),
      stepCount: normalizeNonNegativeInteger(input.stepCount, 'stepCount'),
      successfulSteps: normalizeNonNegativeInteger(input.successfulSteps, 'successfulSteps'),
      blockedSteps: normalizeNonNegativeInteger(input.blockedSteps, 'blockedSteps'),
      errorSteps: normalizeNonNegativeInteger(input.errorSteps, 'errorSteps'),
      usage: normalizeUsage(input.usage),
      errorCode: normalizeContextValue(input, 'errorCode', '', { maxLength: 160, code: OBSERVABILITY_CLIENT_ERRORS.VALUE_INVALID }),
    });
  }

  return Object.freeze({
    workspaceId: scopedWorkspaceId,
    agentId: scopedAgentId,
    runtime: scopedRuntime,
    startRun,
    recordStep,
    recordGateDecision,
    finishRun,
  });
}

module.exports = {
  OBSERVABILITY_CLIENT_ERRORS,
  TELEMETRY_EVENT_TYPES,
  createObservabilityTelemetryClient,
};
