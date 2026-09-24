'use strict';

// The observability HTTP API contract: its paths, the OpenAPI document and
// the manifest. Limits and building blocks live in api-contract-spec.js, the
// component schemas in api-contract-schemas.js (#2191).

const { EVENT_TYPES } = require('./service');
const { schemas } = require('./api-contract-schemas');
const { ALL_ERROR_CODES, ID, MAX_CURSOR_LENGTH, MAX_QUERY_LIMIT, MAX_WINDOW_MS, OBSERVABILITY_API_PREFIX, OBSERVABILITY_API_VERSION, OBSERVABILITY_ERROR_CODES, OBSERVABILITY_LEGACY_PREFIX, OBSERVABILITY_OPENAPI_PATH, REDACTED_RESPONSE_FIELDS, cursorParameter, limitParameter, operation, ref, response, windowParameter, workspaceParameter } = require('./api-contract-spec');

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
  observabilityOpenApiDocument,
};
