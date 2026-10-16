'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildLegacyErrorPayload,
  buildStructuredErrorPayload,
  classifyHttpError,
} = require('../lib/error-taxonomy');
const { writeApiError } = require('../lib/server-response-helpers');

test('HTTP error taxonomy assigns stable classes and operator actions', () => {
  assert.deepEqual(classifyHttpError(400), { errorClass: 'input', operatorAction: 'correct_request' });
  assert.deepEqual(classifyHttpError(401), { errorClass: 'authentication', operatorAction: 'authenticate_and_retry' });
  assert.deepEqual(classifyHttpError(403), { errorClass: 'authorization', operatorAction: 'obtain_authorization' });
  assert.deepEqual(classifyHttpError(404), { errorClass: 'routing', operatorAction: 'verify_route_or_resource' });
  assert.deepEqual(classifyHttpError(405), { errorClass: 'method', operatorAction: 'use_supported_method' });
  assert.deepEqual(classifyHttpError(409), { errorClass: 'state_conflict', operatorAction: 'reconcile_state' });
  assert.deepEqual(classifyHttpError(413), { errorClass: 'request_limit', operatorAction: 'reduce_request_size' });
  assert.deepEqual(classifyHttpError(429), { errorClass: 'rate_limit', operatorAction: 'backoff_and_retry' });
  assert.deepEqual(classifyHttpError(503), { errorClass: 'availability', operatorAction: 'restore_dependency_or_retry' });
  assert.deepEqual(classifyHttpError(500), { errorClass: 'internal', operatorAction: 'inspect_logs_and_retry' });
});

test('legacy HTTP errors preserve the old error string and add machine-readable taxonomy', () => {
  assert.deepEqual(buildLegacyErrorPayload(404, 'NOT_FOUND', 'Not found'), {
    error: 'Not found',
    errorCode: 'NOT_FOUND',
    errorClass: 'routing',
    operatorAction: 'verify_route_or_resource',
  });
});

test('structured API errors carry code, class, operator action and bounded details', () => {
  assert.deepEqual(buildStructuredErrorPayload(503, 'STORE_UNAVAILABLE', 'Store unavailable', { store: 'graph' }), {
    ok: false,
    error: {
      code: 'STORE_UNAVAILABLE',
      message: 'Store unavailable',
      class: 'availability',
      operatorAction: 'restore_dependency_or_retry',
      details: { store: 'graph' },
    },
  });
});

test('writeApiError applies taxonomy to existing structured error callers', () => {
  let status;
  let body;
  const res = {
    writeHead(nextStatus) { status = nextStatus; },
    end(bytes) { body = JSON.parse(bytes); },
  };
  writeApiError({ headers: {} }, res, 409, 'STATE_CONFLICT', 'State conflict');
  assert.equal(status, 409);
  assert.equal(body.error.code, 'STATE_CONFLICT');
  assert.equal(body.error.class, 'state_conflict');
  assert.equal(body.error.operatorAction, 'reconcile_state');
});

test('generic production HTTP boundaries do not regress to the known free-text-only errors', () => {
  const files = [
    'lib/http/server-request-handler.js',
    'lib/http/answer-route.js',
    'lib/http/public-api-route.js',
    'lib/http/core-http-routes.js',
    'lib/http/fitness-dashboard-route.js',
    'lib/http/static-assets.js',
    'lib/http/ingest-http-routes.js',
  ];
  const forbidden = [
    "{ error: 'Bad request' }",
    "{ error: 'Not found' }",
    "{ error: 'Method not allowed' }",
    "{ error: 'Internal server error' }",
    "{ error: 'question is required' }",
    "{ error: 'claim, statement or text is required' }",
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    for (const pattern of forbidden) {
      assert.equal(source.includes(pattern), false, `${file} contains free-text-only boundary error: ${pattern}`);
    }
  }
});
