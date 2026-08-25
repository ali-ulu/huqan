'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  ALL_ERROR_CODES,
  OBSERVABILITY_API_PREFIX,
  OBSERVABILITY_API_VERSION,
  OBSERVABILITY_ERROR_CODES,
  OBSERVABILITY_OPENAPI_PATH,
  REDACTED_RESPONSE_FIELDS,
  observabilityOpenApiDocument,
} = require('../lib/observability/api-contract');
const { createObservabilityHttpRouter } = require('../lib/observability/http-router');
const { PUBLIC_ROUTES, AUTHENTICATED_ROUTES, resolveRouteAuthPolicy } = require('../lib/http/route-auth-policy');

const EXPECTED_PATHS = [
  `${OBSERVABILITY_API_PREFIX}/health`,
  `${OBSERVABILITY_API_PREFIX}/ready`,
  `${OBSERVABILITY_API_PREFIX}/metrics`,
  `${OBSERVABILITY_API_PREFIX}/events`,
  `${OBSERVABILITY_API_PREFIX}/runs`,
  `${OBSERVABILITY_API_PREFIX}/queue`,
  `${OBSERVABILITY_API_PREFIX}/alerts`,
  `${OBSERVABILITY_API_PREFIX}/alert-rules`,
  `${OBSERVABILITY_API_PREFIX}/alert-rules/{ruleId}`,
  `${OBSERVABILITY_API_PREFIX}/stream`,
];

function walkSchema(value, visit) {
  if (!value || typeof value !== 'object') return;
  visit(value);
  for (const child of Object.values(value)) walkSchema(child, visit);
}

function responseRefs(operation, spec) {
  return Object.values(operation.responses || [])
    .map(item => item?.content?.['application/json']?.schema)
    .filter(Boolean)
    .map(schema => schema.$ref
      ? spec.components.schemas[schema.$ref.replace('#/components/schemas/', '')]
      : schema);
}

function harness() {
  const writes = [];
  const calls = [];
  const service = {
    listEvents(input) {
      calls.push({ method: 'listEvents', input });
      return { items: [], limit: 50, hasMore: false, nextCursor: null };
    },
    listRuns(input) {
      calls.push({ method: 'listRuns', input });
      return { items: [], limit: 20, hasMore: false, nextCursor: null };
    },
  };
  let authCalls = 0;
  const router = createObservabilityHttpRouter({
    getService: () => service,
    getHealth: () => ({ inspect: () => ({ liveness: { ok: true }, readiness: { ok: true } }) }),
    parseJsonRequest: async () => null,
    writeJson: (_req, _res, status, response, headers) => writes.push({ status, response, headers }),
    denyIfUnauthorized: req => {
      authCalls += 1;
      req.huqanAuth = Object.freeze({ subject: 'api-contract-test' });
      return true;
    },
    authorizeWorkspace: () => ({ allowed: true }),
  });
  return { router, writes, calls, get authCalls() { return authCalls; } };
}

test('OpenAPI v1 documents exactly the served observability paths and methods', () => {
  const spec = observabilityOpenApiDocument();
  assert.equal(spec.openapi, '3.1.0');
  assert.equal(spec.info.version, OBSERVABILITY_API_VERSION);
  assert.deepEqual(Object.keys(spec.paths).sort(), EXPECTED_PATHS.sort());
  assert.deepEqual(Object.keys(spec.paths[`${OBSERVABILITY_API_PREFIX}/queue`]).sort(), ['get', 'post']);
  assert.deepEqual(Object.keys(spec.paths[`${OBSERVABILITY_API_PREFIX}/alert-rules`]).sort(), ['get', 'post']);
  assert.deepEqual(Object.keys(spec.paths[`${OBSERVABILITY_API_PREFIX}/alert-rules/{ruleId}`]), ['delete']);
});

test('every v1 operation is authenticated, no-store, rate-limited and error-documented', () => {
  const spec = observabilityOpenApiDocument();
  for (const methods of Object.values(spec.paths)) {
    for (const operation of Object.values(methods)) {
      assert.deepEqual(operation.security, [{ bearerApiKey: [] }]);
      assert.equal(operation['x-huqan-observability'].version, OBSERVABILITY_API_VERSION);
      assert.equal(operation['x-huqan-observability'].cache, 'no-store');
      assert.equal(operation['x-huqan-observability'].rateLimit.enforced, true);
      for (const status of [400, 401, 403, 405, 429, 503]) assert.ok(operation.responses[status]);
      assert.ok(operation.responses[200] || operation.responses[201] || operation.responses[202]);
    }
  }
  const policy = resolveRouteAuthPolicy(`${OBSERVABILITY_API_PREFIX}/events`, 'GET');
  assert.deepEqual(policy, { known: true, authRequired: true, ruleId: 'observability', reason: 'declared_authenticated' });
});

test('response schemas exclude plaintext telemetry fields and expose only bounded pagination', () => {
  const spec = observabilityOpenApiDocument();
  const responseSchemas = Object.values(spec.paths).flatMap(methods => Object.values(methods)).flatMap(operation => responseRefs(operation, spec));
  const forbidden = new Set(REDACTED_RESPONSE_FIELDS);
  for (const schema of responseSchemas) {
    walkSchema(schema, node => {
      for (const propertyName of Object.keys(node.properties || {})) assert.equal(forbidden.has(propertyName), false, propertyName);
    });
  }
  assert.equal(spec['x-huqan-observability'].pagination.style, 'cursor');
  assert.equal(spec['x-huqan-observability'].pagination.maxLimit, 100);
  assert.equal(spec['x-huqan-observability'].pagination.maxCursorLength, 512);
  assert.deepEqual(spec['x-huqan-observability'].redaction.forbiddenResponseFields, REDACTED_RESPONSE_FIELDS);
});

test('error code groups are unique and cover the documented API error vocabulary', () => {
  const groups = Object.values(OBSERVABILITY_ERROR_CODES).flat();
  assert.deepEqual([...new Set(groups)].sort(), [...ALL_ERROR_CODES].sort());
  assert.ok(OBSERVABILITY_ERROR_CODES.auth.includes('UNAUTHORIZED'));
  assert.ok(OBSERVABILITY_ERROR_CODES.rateLimit.includes('OBSERVABILITY_RATE_LIMITED'));
  assert.ok(OBSERVABILITY_ERROR_CODES.server.includes('OBSERVABILITY_DATABASE_UNAVAILABLE'));
  assert.equal(observabilityOpenApiDocument().components.schemas.Error.properties.code.enum.length, ALL_ERROR_CODES.length);
});

test('v1 and legacy paths share the same bounded router behavior', async () => {
  for (const pathname of [`${OBSERVABILITY_API_PREFIX}/events`, '/api/observability/events']) {
    const h = harness();
    const handled = await h.router({ method: 'GET', headers: {} }, {}, new URL(`http://local${pathname}?workspaceId=ws-a`));
    assert.equal(handled, true, pathname);
    assert.equal(h.writes[0].status, 200);
    assert.equal(h.writes[0].response.ok, true);
    assert.equal(h.calls.length, 1);
    assert.equal(h.authCalls, 1);
    assert.deepEqual(h.calls[0].input, { workspaceId: 'ws-a', limit: undefined, cursor: undefined, eventType: undefined, runId: undefined, status: undefined });
  }
});

test('runs operation documents and forwards its bounded time window', async () => {
  const spec = observabilityOpenApiDocument();
  const parameters = spec.paths[`${OBSERVABILITY_API_PREFIX}/runs`].get.parameters;
  assert.deepEqual(parameters.find(parameter => parameter.name === 'windowMs').schema, { type: 'integer', minimum: 1000, maximum: 31 * 24 * 60 * 60 * 1000 });

  const h = harness();
  const handled = await h.router({ method: 'GET', headers: {} }, {}, new URL(`http://local${OBSERVABILITY_API_PREFIX}/runs?workspaceId=ws-a&limit=20&windowMs=3600000`));
  assert.equal(handled, true);
  assert.equal(h.writes[0].status, 200);
  assert.deepEqual(h.calls[0], {
    method: 'listRuns',
    input: { workspaceId: 'ws-a', limit: '20', cursor: undefined, eventType: undefined, runId: undefined, status: undefined, windowMs: '3600000' },
  });
});

test('OpenAPI metadata is public GET-only and served from the generated document', async () => {
  const publicRule = PUBLIC_ROUTES.find(rule => rule.id === 'observability-openapi');
  assert.deepEqual(publicRule.methods, ['GET']);
  assert.equal(publicRule.match.pathname, OBSERVABILITY_OPENAPI_PATH);
  assert.deepEqual(resolveRouteAuthPolicy(OBSERVABILITY_OPENAPI_PATH, 'GET'), { known: true, authRequired: false, ruleId: 'observability-openapi', reason: 'public_route' });
  assert.deepEqual(resolveRouteAuthPolicy(OBSERVABILITY_OPENAPI_PATH, 'POST'), { known: true, authRequired: true, ruleId: 'observability-openapi', reason: 'method_not_public' });
  assert.ok(AUTHENTICATED_ROUTES.some(rule => rule.id === 'observability'));

  const h = harness();
  const handled = await h.router({ method: 'GET', headers: {} }, {}, new URL(`http://local${OBSERVABILITY_OPENAPI_PATH}`));
  assert.equal(handled, true);
  assert.equal(h.writes[0].status, 200);
  assert.equal(h.writes[0].headers['Cache-Control'], 'no-store');
  assert.deepEqual(h.writes[0].response, observabilityOpenApiDocument());
  assert.equal(h.authCalls, 0);

  const method = harness();
  const methodHandled = await method.router({ method: 'POST', headers: {} }, {}, new URL(`http://local${OBSERVABILITY_OPENAPI_PATH}`));
  assert.equal(methodHandled, true);
  assert.equal(method.writes[0].status, 405);
  assert.equal(method.writes[0].response.error.code, 'METHOD_NOT_ALLOWED');
});

test('migration runbook names the versioned prefix, OpenAPI path and compatibility boundary', () => {
  const runbook = fs.readFileSync(path.join(__dirname, '..', 'docs', 'observability-api-v1.md'), 'utf8');
  assert.match(runbook, /\/api\/observability\/v1/);
  assert.match(runbook, /\/api\/observability\/openapi\.json/);
  assert.match(runbook, /no-store/);
  assert.match(runbook, /goalDigest/);
  assert.match(runbook, /external notification delivery/);
});
