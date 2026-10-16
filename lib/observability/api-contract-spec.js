'use strict';

// #2191: the observability API's version, limits and error codes, and the
// OpenAPI building blocks (schema helpers, shared parameters) that
// api-contract-schemas.js and api-contract.js compose.

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

module.exports = {
  ALL_ERROR_CODES,
  ID,
  MAX_CURSOR_LENGTH,
  MAX_QUERY_LIMIT,
  MAX_WINDOW_MS,
  NULLABLE_ID,
  OBSERVABILITY_API_PREFIX,
  OBSERVABILITY_API_VERSION,
  OBSERVABILITY_ERROR_CODES,
  OBSERVABILITY_LEGACY_PREFIX,
  OBSERVABILITY_OPENAPI_PATH,
  REDACTED_RESPONSE_FIELDS,
  SAFE_VALUE,
  TIMESTAMP,
  cursorParameter,
  limitParameter,
  objectSchema,
  operation,
  ref,
  response,
  windowParameter,
  workspaceParameter,
};
