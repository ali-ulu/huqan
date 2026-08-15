'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { WORKFLOW_CAPABILITIES, COMPATIBILITY_COMMANDS, workflowOpenApiDocument } = require('../lib/workflow-contract');
const { PUBLIC_ROUTES, AUTHENTICATED_ROUTES } = require('../lib/http/route-auth-policy');
const { handleWorkflowContractRoute } = require('../lib/http/workflow-contract-route');

function authPaths() {
  return [...PUBLIC_ROUTES, ...AUTHENTICATED_ROUTES].map(rule => rule.match.pathname || rule.match.prefix);
}

test('OpenAPI is generated only for HTTP-available manifest operations', () => {
  const spec = workflowOpenApiDocument();
  const advertised = WORKFLOW_CAPABILITIES.filter(item => item.availability.api)
    .map(item => `${item.method} ${item.route}`).sort();
  const documented = Object.entries(spec.paths)
    .flatMap(([route, methods]) => Object.keys(methods).map(method => `${method.toUpperCase()} ${route}`)).sort();
  assert.deepEqual(documented, advertised);
  for (const unavailable of WORKFLOW_CAPABILITIES.filter(item => !item.availability.api)) {
    assert.equal(spec.paths[unavailable.route], undefined, `${unavailable.workflowId} must not be advertised as HTTP`);
  }
});

test('every documented route is auth-declared and carries schema/security/policies', () => {
  const spec = workflowOpenApiDocument();
  const declared = authPaths();
  for (const [route, methods] of Object.entries(spec.paths)) {
    assert.ok(declared.some(pathname => pathname === route || (pathname?.endsWith('/') && route.startsWith(pathname)) || (route.includes('{id}') && pathname?.endsWith('/'))), `${route} has auth policy`);
    for (const operation of Object.values(methods)) {
      assert.deepEqual(operation.security, [{ bearerApiKey: [] }]);
      assert.equal(operation['x-huqan-workflow'].cache, 'no-store');
      assert.equal(operation['x-huqan-workflow'].cors.origins, 'loopback-only');
      assert.equal(operation['x-huqan-workflow'].rateLimit.enforced, true);
      assert.ok(operation.responses[400]);
      if (operation.requestBody) {
        assert.ok(operation.requestBody.content['application/json'].schema);
        assert.ok(Number.isSafeInteger(operation.requestBody['x-maxBytes']));
      }
    }
  }
});

test('OpenAPI metadata route is explicitly public GET-only', () => {
  const route = PUBLIC_ROUTES.find(item => item.id === 'workflow-openapi');
  assert.deepEqual(route.methods, ['GET']);
  assert.equal(route.match.pathname, '/api/v2/openapi.json');
});

test('OpenAPI route serves the document generated from the same manifest', () => {
  let write;
  const res = { writeHead: (status, headers) => { write = { status, headers }; }, end: body => { write.body = body; } };
  const handled = handleWorkflowContractRoute({ method: 'GET', headers: {} }, res, new URL('http://localhost/api/v2/openapi.json'));
  assert.equal(handled, true);
  assert.equal(write.status, 200);
  assert.equal(write.headers['Cache-Control'], 'no-store');
  assert.deepEqual(JSON.parse(write.body), workflowOpenApiDocument());
});

test('help compatibility commands and migration notes stay tied to the canonical contract', () => {
  const help = require('../lib/workflow-contract').compatibilityHelpText();
  for (const item of COMPATIBILITY_COMMANDS) assert.match(help, new RegExp(`"${item.command}"`));
  const migration = fs.readFileSync(path.join(__dirname, '..', 'docs', 'workflow-http-migration.md'), 'utf8');
  assert.match(migration, /\/api\/v2\/workflows/);
  assert.match(migration, /\/api\/v2\/openapi\.json/);
  for (const id of ['learn-review', 'ingest-preview', 'agent-plan', 'agent-run']) assert.match(migration, new RegExp(`\\b${id}\\b`));
});
