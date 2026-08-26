'use strict';

const {
  ALERT_METRICS,
  ALERT_OPERATORS,
  EVENT_TYPES,
} = require('./service');

const OBSERVABILITY_API_VERSION = '1.0.0';
const OBSERVABILITY_API_PREFIX = '/api/observability/v1';
const OBSERVABILITY_LEGACY_PREFIX = '/api/observability';
const OBSERVABILITY_OPENAPI_PATH = `${OBSERVABILITY_LEGACY_PREFIX}/openapi.json`;
const MAX_QUERY_LIMIT = 100;
const MAX_CURSOR_LENGTH = 512;
const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
const REDACTED_RESPONSE_FIELDS = Object.freeze([
  'goal',
  'prompt',
  'input',
  'output',
  'secret',
  'credential',
  'authorization',
]);

const OBSERVABILITY_ERROR_CODES = Object.freeze({
  auth: Object.freeze(['UNAUTHORIZED', 'OBSERVABILITY_AUTHORIZATION_UNAVAILABLE']),
  workspace: Object.freeze(['MISSING_WORKSPACE_ID', 'INVALID_WORKSPACE_ID', 'OBSERVABILITY_WORKSPACE_FORBIDDEN', 'OBSERVABILITY_PERMISSION_FORBIDDEN']),
  validation: Object.freeze([
    'OBSERVABILITY_QUERY_INVALID',
    'INVALID_EVENT_TYPE',
    'INVALID_RUN_ID',
    'INVALID_ALERT_RULE',
    'INVALID_QUEUE_GOAL',
    'ALERT_RULE_LIMIT_REACHED',
    'METHOD_NOT_ALLOWED',
  ]),
  rateLimit: Object.freeze(['OBSERVABILITY_RATE_LIMITED']),
  server: Object.freeze([
    'OBSERVABILITY_DATABASE_UNAVAILABLE',
    'OBSERVABILITY_UNAVAILABLE',
    'OBSERVABILITY_FAILED',
  ]),
});
const ALL_ERROR_CODES = Object.freeze([
  ...OBSERVABILITY_ERROR_CODES.auth,
  ...OBSERVABILITY_ERROR_CODES.workspace,
  ...OBSERVABILITY_ERROR_CODES.validation,
  ...OBSERVABILITY_ERROR_CODES.rateLimit,
  ...OBSERVABILITY_ERROR_CODES.server,
]);

const ID = Object.freeze({ type: 'string', minLength: 1, maxLength: 128 });
const NULLABLE_ID = Object.freeze({ type: ['string', 'null'], maxLength: 128 });
const TIMESTAMP = Object.freeze({ type: ['string', 'null'], format: 'date-time' });
const SAFE_VALUE = Object.freeze({
  anyOf: [
    { type: 'null' },
    { type: 'string', maxLength: 512 },
    { type: 'number' },
    { type: 'boolean' },
    { type: 'array', maxItems: 20, items: { anyOf: [{ type: 'null' }, { type: 'string', maxLength: 256 }, { type: 'number' }, { type: 'boolean' }] } },
  ],
});

function objectSchema(properties, required = Object.keys(properties), extra = {}) {
  return {
    type: 'object',
    additionalProperties: false,
    required,
    properties,
    ...extra,
  };
}

function ref(name) {
  return { $ref: `#/components/schemas/${name}` };
}

function response(description, schema) {
  return {
    description,
    content: { 'application/json': { schema } },
  };
}

function errorResponses() {
  return {
    400: { $ref: '#/components/responses/BadRequest' },
    401: { $ref: '#/components/responses/Unauthorized' },
    403: { $ref: '#/components/responses/Forbidden' },
    405: { $ref: '#/components/responses/MethodNotAllowed' },
    429: { $ref: '#/components/responses/RateLimited' },
    503: { $ref: '#/components/responses/Unavailable' },
  };
}

function operation({ operationId, summary, method, parameters = [], schema, status = 200, requestBody, stream = false }) {
  const content = stream
    ? { 'text/event-stream': { schema: { type: 'string', description: 'SSE records; each data field is a StreamEvent JSON value.' } } }
    : { 'application/json': { schema } };
  return {
    operationId,
    summary,
    tags: ['observability'],
    security: [{ bearerApiKey: [] }],
    parameters,
    ...(requestBody ? { requestBody } : {}),
    responses: {
      [status]: { description: 'Successful observability response.', content },
      ...errorResponses(),
    },
    'x-huqan-observability': {
      version: OBSERVABILITY_API_VERSION,
      legacyPrefix: OBSERVABILITY_LEGACY_PREFIX,
      cache: 'no-store',
      rateLimit: { enforced: true, dimensions: ['subject', 'workspace'] },
      redaction: { responseFields: [...REDACTED_RESPONSE_FIELDS], payload: 'safePayload only' },
    },
  };
}

const workspaceParameter = Object.freeze({
  name: 'workspaceId',
  in: 'query',
  required: true,
  schema: { type: 'string', minLength: 1, maxLength: 128 },
});
const limitParameter = Object.freeze({
  name: 'limit',
  in: 'query',
  required: false,
  schema: { type: 'integer', minimum: 1, maximum: MAX_QUERY_LIMIT },
});
const cursorParameter = Object.freeze({
  name: 'cursor',
  in: 'query',
  required: false,
  schema: { type: 'string', minLength: 1, maxLength: MAX_CURSOR_LENGTH },
});
const windowParameter = Object.freeze({
  name: 'windowMs',
  in: 'query',
  required: false,
  schema: { type: 'integer', minimum: 1000, maximum: MAX_WINDOW_MS },
});

const schemas = {
  Error: objectSchema({
    code: { type: 'string', enum: ALL_ERROR_CODES },
    message: { type: 'string', maxLength: 256 },
  }),
  ApiError: objectSchema({
    ok: { const: false },
    error: ref('Error'),
  }),
  Event: objectSchema({
    eventId: ID,
    workspaceId: ID,
    runId: NULLABLE_ID,
    traceId: NULLABLE_ID,
    agentId: NULLABLE_ID,
    eventType: { type: 'string', enum: [...EVENT_TYPES] },
    status: { type: ['string', 'null'], maxLength: 64 },
    tool: { type: ['string', 'null'], maxLength: 128 },
    durationMs: { type: ['integer', 'null'], minimum: 0 },
    tokens: { type: ['integer', 'null'], minimum: 0 },
    inputTokens: { type: ['integer', 'null'], minimum: 0 },
    outputTokens: { type: ['integer', 'null'], minimum: 0 },
    costMicros: { type: ['integer', 'null'], minimum: 0 },
    costKnown: { type: 'boolean' },
    payload: { type: 'object', additionalProperties: SAFE_VALUE, description: 'Bounded safePayload; sensitive plaintext keys are removed before persistence and response.' },
    createdAt: { type: 'string', format: 'date-time' },
  }),
  Run: objectSchema({
    runId: ID,
    workspaceId: ID,
    agentId: NULLABLE_ID,
    runtime: { type: 'string', maxLength: 128 },
    goalDigest: { type: ['string', 'null'], pattern: '^[a-f0-9]{64}$' },
    goalLength: { type: 'integer', minimum: 0 },
    objective: { type: ['string', 'null'], maxLength: 512 },
    status: { type: 'string', maxLength: 64 },
    startedAt: { type: 'string', format: 'date-time' },
    finishedAt: TIMESTAMP,
    durationMs: { type: ['integer', 'null'], minimum: 0 },
    stepCount: { type: 'integer', minimum: 0 },
    successfulSteps: { type: 'integer', minimum: 0 },
    blockedSteps: { type: 'integer', minimum: 0 },
    errorSteps: { type: 'integer', minimum: 0 },
    tokens: { type: ['integer', 'null'], minimum: 0 },
    inputTokens: { type: ['integer', 'null'], minimum: 0 },
    outputTokens: { type: ['integer', 'null'], minimum: 0 },
    costMicros: { type: ['integer', 'null'], minimum: 0 },
    costKnown: { type: 'boolean' },
    errorCode: { type: ['string', 'null'], maxLength: 160 },
    updatedAt: { type: 'string', format: 'date-time' },
  }),
  RunWithTools: objectSchema({
    ...objectSchema({}).properties,
    runId: ID,
    workspaceId: ID,
    agentId: NULLABLE_ID,
    runtime: { type: 'string', maxLength: 128 },
    goalDigest: { type: ['string', 'null'], pattern: '^[a-f0-9]{64}$' },
    goalLength: { type: 'integer', minimum: 0 },
    objective: { type: ['string', 'null'], maxLength: 512 },
    status: { type: 'string', maxLength: 64 },
    startedAt: { type: 'string', format: 'date-time' },
    finishedAt: TIMESTAMP,
    durationMs: { type: ['integer', 'null'], minimum: 0 },
    stepCount: { type: 'integer', minimum: 0 },
    successfulSteps: { type: 'integer', minimum: 0 },
    blockedSteps: { type: 'integer', minimum: 0 },
    errorSteps: { type: 'integer', minimum: 0 },
    tokens: { type: ['integer', 'null'], minimum: 0 },
    inputTokens: { type: ['integer', 'null'], minimum: 0 },
    outputTokens: { type: ['integer', 'null'], minimum: 0 },
    costMicros: { type: ['integer', 'null'], minimum: 0 },
    costKnown: { type: 'boolean' },
    errorCode: { type: ['string', 'null'], maxLength: 160 },
    updatedAt: { type: 'string', format: 'date-time' },
    tools: { type: 'array', items: ref('ToolUsage') },
    toolCallCount: { type: 'integer', minimum: 0 },
  }),
  ToolUsage: objectSchema({
    name: { type: 'string', maxLength: 128 },
    count: { type: 'integer', minimum: 0 },
  }),
  PageEvents: objectSchema({
    items: { type: 'array', items: ref('Event') },
    limit: { type: 'integer', minimum: 1, maximum: MAX_QUERY_LIMIT },
    hasMore: { type: 'boolean' },
    nextCursor: { type: ['string', 'null'], maxLength: MAX_CURSOR_LENGTH },
  }),
  PageRuns: objectSchema({
    items: { type: 'array', items: ref('RunWithTools') },
    limit: { type: 'integer', minimum: 1, maximum: MAX_QUERY_LIMIT },
    hasMore: { type: 'boolean' },
    nextCursor: { type: ['string', 'null'], maxLength: MAX_CURSOR_LENGTH },
  }),
  Metrics: objectSchema({
    workspaceId: ID,
    windowMs: { type: 'integer', minimum: 1000, maximum: MAX_WINDOW_MS },
    since: { type: 'string', format: 'date-time' },
    totalRuns: { type: 'integer', minimum: 0 },
    completedRuns: { type: 'integer', minimum: 0 },
    failedRuns: { type: 'integer', minimum: 0 },
    successRate: { type: ['number', 'null'], minimum: 0, maximum: 1 },
    avgLatencyMs: { type: ['number', 'null'], minimum: 0 },
    p95LatencyMs: { type: ['number', 'null'], minimum: 0 },
    totalTokens: { type: 'integer', minimum: 0 },
    tokenKnown: { type: 'boolean' },
    totalCostMicros: { type: ['integer', 'null'], minimum: 0 },
    costKnown: { type: 'boolean' },
    errorRuns: { type: 'integer', minimum: 0 },
    queueDepth: { type: 'integer', minimum: 0 },
    toolUsage: { type: 'array', items: ref('ToolUsage') },
    toolCallCount: { type: 'integer', minimum: 0 },
    generatedAt: { type: 'string', format: 'date-time' },
  }),
  QueueJob: objectSchema({
    jobId: ID,
    workspaceId: ID,
    agentId: NULLABLE_ID,
    goalDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    goalLength: { type: 'integer', minimum: 0 },
    maxSteps: { type: 'integer', minimum: 1, maximum: 8 },
    status: { type: 'string', enum: ['queued', 'running', 'completed', 'failed', 'dead'] },
    attempts: { type: 'integer', minimum: 0 },
    maxAttempts: { type: 'integer', minimum: 1, maximum: 5 },
    availableAt: { type: 'string', format: 'date-time' },
    leaseUntil: TIMESTAMP,
    workerId: NULLABLE_ID,
    runId: NULLABLE_ID,
    errorCode: { type: ['string', 'null'], maxLength: 160 },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  }),
  QueueSummary: objectSchema({
    workspaceId: ID,
    byStatus: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } },
    depth: { type: 'integer', minimum: 0 },
    oldestActiveAt: TIMESTAMP,
    lagMs: { type: 'integer', minimum: 0 },
  }),
  QueueCollection: objectSchema({
    workspaceId: ID,
    byStatus: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } },
    depth: { type: 'integer', minimum: 0 },
    oldestActiveAt: TIMESTAMP,
    lagMs: { type: 'integer', minimum: 0 },
    items: { type: 'array', items: ref('QueueJob') },
  }),
  AlertRule: objectSchema({
    ruleId: ID,
    workspaceId: ID,
    name: { type: 'string', maxLength: 160 },
    metric: { type: 'string', enum: [...ALERT_METRICS] },
    operator: { type: 'string', enum: [...ALERT_OPERATORS] },
    threshold: { type: 'number' },
    windowMs: { type: 'integer', minimum: 1000, maximum: MAX_WINDOW_MS },
    cooldownMs: { type: 'integer', minimum: 1000, maximum: MAX_WINDOW_MS },
    enabled: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  }),
  Alert: objectSchema({
    alertId: ID,
    ruleId: ID,
    workspaceId: ID,
    metric: { type: 'string', enum: [...ALERT_METRICS] },
    value: { type: 'number' },
    threshold: { type: 'number' },
    status: { type: 'string', enum: ['firing', 'acknowledged', 'resolved'] },
    fingerprint: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    eventId: NULLABLE_ID,
    firedAt: { type: 'string', format: 'date-time' },
    resolvedAt: TIMESTAMP,
  }),
  Health: objectSchema({
    liveness: objectSchema({ ok: { type: 'boolean' } }),
    readiness: objectSchema({ ok: { type: 'boolean' } }),
    database: objectSchema({ ok: { type: 'boolean' } }),
    schema: objectSchema({ ok: { type: 'boolean' }, missingTables: { type: 'array', items: { type: 'string' } } }),
    worker: objectSchema({ enabled: { type: 'boolean' }, running: { type: 'boolean' }, busy: { type: 'boolean' } }),
    queue: objectSchema({ depth: { type: ['integer', 'null'], minimum: 0 }, lagMs: { type: ['integer', 'null'], minimum: 0 } }),
    lastEventWriteAt: TIMESTAMP,
    checkedAt: { type: 'string', format: 'date-time' },
    error: { type: 'object', additionalProperties: false, required: ['code'], properties: { code: { type: 'string', enum: ['OBSERVABILITY_DATABASE_UNAVAILABLE'] } } },
  }),
  StreamEvent: objectSchema({
    event: { type: 'string' },
    data: { anyOf: [ref('Event'), objectSchema({ ok: { const: true }, workspaceId: ID })] },
  }),
  QueueCreate: objectSchema({
    workspaceId: ID,
    agentId: { type: 'string', maxLength: 128 },
    goal: { type: 'string', minLength: 1, maxLength: 4000, writeOnly: true },
    maxSteps: { type: 'integer', minimum: 1, maximum: 8 },
    maxAttempts: { type: 'integer', minimum: 1, maximum: 5 },
  }, ['workspaceId', 'goal']),
  AlertRuleCreate: objectSchema({
    workspaceId: ID,
    name: { type: 'string', maxLength: 160 },
    metric: { type: 'string', enum: [...ALERT_METRICS] },
    operator: { type: 'string', enum: [...ALERT_OPERATORS] },
    threshold: { type: 'number' },
    windowMs: { type: 'integer', minimum: 1000, maximum: MAX_WINDOW_MS },
    cooldownMs: { type: 'integer', minimum: 1000, maximum: MAX_WINDOW_MS },
    enabled: { type: 'boolean' },
  }, ['workspaceId', 'metric', 'operator', 'threshold']),
  InternalMetrics: objectSchema({
    workspaceId: ID,
    subscriberCount: { type: 'integer', minimum: 0 },
    eventWrites: objectSchema({ attempted: { type: 'integer', minimum: 0 }, succeeded: { type: 'integer', minimum: 0 }, failed: { type: 'integer', minimum: 0 } }),
    droppedEvents: { type: 'integer', minimum: 0 },
    projectionFailures: { type: 'integer', minimum: 0 },
    summary: objectSchema({ calls: { type: 'integer', minimum: 0 }, totalDurationMs: { type: 'integer', minimum: 0 }, slowCalls: { type: 'integer', minimum: 0 } }),
    alertEvaluation: objectSchema({ calls: { type: 'integer', minimum: 0 }, failures: { type: 'integer', minimum: 0 }, totalDurationMs: { type: 'integer', minimum: 0 } }),
  }),
  ResponseEventPage: objectSchema({ ok: { const: true }, data: ref('PageEvents') }),
  ResponseRunPage: objectSchema({ ok: { const: true }, data: ref('PageRuns') }),
  ResponseMetrics: objectSchema({ ok: { const: true }, data: objectSchema({ metrics: ref('Metrics'), queue: ref('QueueSummary'), alerts: { type: 'array', items: ref('Alert') }, internal: ref('InternalMetrics') }) }),
  ResponseQueue: objectSchema({ ok: { const: true }, data: ref('QueueCollection') }),
  ResponseQueueJob: objectSchema({ ok: { const: true }, data: ref('QueueJob') }),
  ResponseAlert: objectSchema({ ok: { const: true }, data: objectSchema({ items: { type: 'array', items: ref('Alert') } }) }),
  ResponseAlertRule: objectSchema({ ok: { const: true }, data: objectSchema({ items: { type: 'array', items: ref('AlertRule') } }) }),
  ResponseHealth: objectSchema({ ok: { type: 'boolean' }, data: ref('Health') }),
  ResponseAlertRuleCreated: objectSchema({ ok: { const: true }, data: ref('AlertRule') }),
  ResponseDeleted: objectSchema({ ok: { type: 'boolean' }, data: objectSchema({ deleted: { type: 'boolean' } }) }),
};

const OBSERVABILITY_PATHS = {
  [`${OBSERVABILITY_API_PREFIX}/health`]: {
    get: operation({ operationId: 'observability-health', summary: 'Read workspace liveness and readiness.', method: 'GET', parameters: [workspaceParameter], schema: ref('ResponseHealth') }),
  },
  [`${OBSERVABILITY_API_PREFIX}/ready`]: {
    get: operation({ operationId: 'observability-ready', summary: 'Read workspace readiness.', method: 'GET', parameters: [workspaceParameter], schema: ref('ResponseHealth') }),
  },
  [`${OBSERVABILITY_API_PREFIX}/metrics`]: {
    get: operation({ operationId: 'observability-metrics', summary: 'Read bounded workspace metrics and queue/alert summaries.', method: 'GET', parameters: [workspaceParameter, windowParameter], schema: ref('ResponseMetrics') }),
  },
  [`${OBSERVABILITY_API_PREFIX}/events`]: {
    get: operation({ operationId: 'observability-events', summary: 'Read redacted workspace events with cursor pagination and an optional time window.', method: 'GET', parameters: [workspaceParameter, limitParameter, cursorParameter, windowParameter, { name: 'eventType', in: 'query', schema: { type: 'string', enum: [...EVENT_TYPES] } }, { name: 'runId', in: 'query', schema: ID }], schema: ref('ResponseEventPage') }),
  },
  [`${OBSERVABILITY_API_PREFIX}/runs`]: {
    get: operation({ operationId: 'observability-runs', summary: 'Read redacted workspace runs with cursor pagination and an optional time window.', method: 'GET', parameters: [workspaceParameter, limitParameter, cursorParameter, windowParameter, { name: 'status', in: 'query', schema: { type: 'string', maxLength: 64 } }], schema: ref('ResponseRunPage') }),
  },
  [`${OBSERVABILITY_API_PREFIX}/queue`]: {
    get: operation({ operationId: 'observability-queue', summary: 'Read bounded workspace queue state.', method: 'GET', parameters: [workspaceParameter, limitParameter], schema: ref('ResponseQueue') }),
    post: operation({ operationId: 'observability-queue-enqueue', summary: 'Enqueue a bounded workspace job.', method: 'POST', parameters: [], status: 202, schema: ref('ResponseQueueJob'), requestBody: { required: true, content: { 'application/json': { schema: ref('QueueCreate'), 'x-maxBytes': 12288 } } } }),
  },
  [`${OBSERVABILITY_API_PREFIX}/alerts`]: {
    get: operation({ operationId: 'observability-alerts', summary: 'Read bounded workspace alerts.', method: 'GET', parameters: [workspaceParameter, limitParameter], schema: ref('ResponseAlert') }),
  },
  [`${OBSERVABILITY_API_PREFIX}/alert-rules`]: {
    get: operation({ operationId: 'observability-alert-rules', summary: 'Read bounded workspace alert rules.', method: 'GET', parameters: [workspaceParameter, limitParameter], schema: ref('ResponseAlertRule') }),
    post: operation({ operationId: 'observability-alert-rules-create', summary: 'Create a bounded workspace alert rule.', method: 'POST', parameters: [], status: 201, schema: ref('ResponseAlertRuleCreated'), requestBody: { required: true, content: { 'application/json': { schema: ref('AlertRuleCreate'), 'x-maxBytes': 4096 } } } }),
  },
  [`${OBSERVABILITY_API_PREFIX}/alert-rules/{ruleId}`]: {
    delete: operation({ operationId: 'observability-alert-rule-delete', summary: 'Delete one workspace alert rule.', method: 'DELETE', parameters: [workspaceParameter, { name: 'ruleId', in: 'path', required: true, schema: ID }], schema: ref('ResponseDeleted') }),
  },
  [`${OBSERVABILITY_API_PREFIX}/stream`]: {
    get: operation({ operationId: 'observability-stream', summary: 'Stream redacted workspace events over SSE.', method: 'GET', parameters: [workspaceParameter], schema: ref('StreamEvent'), stream: true }),
  },
};

function observabilityOpenApiDocument() {
  return structuredClone({
    openapi: '3.1.0',
    info: {
      title: 'HUQAN Observability HTTP API',
      version: OBSERVABILITY_API_VERSION,
      description: 'Versioned, workspace-scoped, bounded and redacted observability read/write contract. Legacy /api/observability routes remain compatibility aliases for v1.',
    },
    servers: [{ url: '/' }],
    tags: [{ name: 'observability', description: 'Workspace-scoped observability telemetry and bounded queue/alert operations.' }],
    paths: OBSERVABILITY_PATHS,
    components: {
      securitySchemes: { bearerApiKey: { type: 'http', scheme: 'bearer', description: 'HUQAN_API_KEY' } },
      schemas,
      responses: {
        BadRequest: response('Validation or workspace scope failure.', ref('ApiError')),
        Unauthorized: response('API key is missing or invalid.', ref('ApiError')),
        Forbidden: response('Workspace or permission policy denied the request.', ref('ApiError')),
        MethodNotAllowed: response('HTTP method is not supported for this route.', ref('ApiError')),
        RateLimited: response('Subject/workspace rate limit exceeded.', ref('ApiError')),
        Unavailable: response('Observability storage or authorization is unavailable.', ref('ApiError')),
      },
    },
    'x-huqan-observability': {
      apiVersion: OBSERVABILITY_API_VERSION,
      legacyPrefix: OBSERVABILITY_LEGACY_PREFIX,
      versionedPrefix: OBSERVABILITY_API_PREFIX,
      compatibility: 'Legacy unversioned routes are retained as aliases; new clients should use /api/observability/v1.',
      pagination: { style: 'cursor', order: 'descending timestamp then stable id', maxLimit: MAX_QUERY_LIMIT, maxCursorLength: MAX_CURSOR_LENGTH },
      redaction: { forbiddenResponseFields: [...REDACTED_RESPONSE_FIELDS], persistedPayload: 'safePayload' },
      errorCodes: OBSERVABILITY_ERROR_CODES,
    },
  });
}

function observabilityApiManifest() {
  return {
    apiVersion: OBSERVABILITY_API_VERSION,
    versionedPrefix: OBSERVABILITY_API_PREFIX,
    legacyPrefix: OBSERVABILITY_LEGACY_PREFIX,
    openApiPath: OBSERVABILITY_OPENAPI_PATH,
    redacted: true,
    pagination: { style: 'cursor', maxLimit: MAX_QUERY_LIMIT, maxCursorLength: MAX_CURSOR_LENGTH },
  };
}

module.exports = {
  ALL_ERROR_CODES,
  MAX_CURSOR_LENGTH,
  MAX_QUERY_LIMIT,
  MAX_WINDOW_MS,
  OBSERVABILITY_API_PREFIX,
  OBSERVABILITY_API_VERSION,
  OBSERVABILITY_ERROR_CODES,
  OBSERVABILITY_LEGACY_PREFIX,
  OBSERVABILITY_OPENAPI_PATH,
  REDACTED_RESPONSE_FIELDS,
  observabilityApiManifest,
  observabilityOpenApiDocument,
};
