'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const yaml = require('js-yaml');
const { createObservabilityHttpRouter, matchApiPrefix, PREFIX, VERSIONED_PREFIX } = require('./http-router');

const specPath = path.join(__dirname, '..', '..', 'docs', 'openapi-observability-v1.yaml');

function operations(spec) {
  return Object.entries(spec.paths).flatMap(([route, item]) => Object.entries(item).map(([method, operation]) => ({ route, method, operation })));
}

function resolveRef(spec, ref) {
  return ref.split('/').slice(1).reduce((value, key) => value?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], spec);
}

test('OpenAPI v1 covers every runtime surface and standard failure contract', () => {
  const spec = yaml.load(fs.readFileSync(specPath, 'utf8'));
  assert.equal(spec.openapi, '3.1.0');
  assert.equal(spec.servers[0].url, VERSIONED_PREFIX);
  assert.deepEqual(Object.keys(spec.paths).sort(), [
    '/alert-rules', '/alert-rules/{ruleId}', '/alerts', '/alerts/{alertId}/acknowledge',
    '/events', '/internal-metrics', '/metrics', '/queue', '/runs', '/stream',
  ]);
  for (const { route, method, operation } of operations(spec)) {
    for (const status of ['400', '401', '403', '429', '503']) {
      assert.ok(operation.responses[status], `${method.toUpperCase()} ${route} lacks ${status}`);
      const response = resolveRef(spec, operation.responses[status].$ref);
      const schema = resolveRef(spec, response.content['application/json'].schema.$ref);
      assert.deepEqual(schema.required, ['ok', 'error']);
    }
  }
  assert.equal(spec.components.parameters.Limit.schema.maximum, 100);
  assert.equal(spec.components.parameters.Cursor.schema.maxLength, 512);
  assert.equal(spec.components.parameters.WindowMs.schema.minimum, 1000);
  for (const route of ['/events', '/runs', '/queue', '/alerts', '/alert-rules']) {
    const refs = spec.paths[route].get.parameters.map(item => item.$ref);
    assert.ok(refs.includes('#/components/parameters/Limit'), `${route} limit`);
    assert.ok(refs.includes('#/components/parameters/Cursor'), `${route} cursor`);
    assert.match(spec.paths[route].get.description, /first\.$/);
  }
});

test('no success response schema exposes sensitive plaintext fields', () => {
  const spec = yaml.load(fs.readFileSync(specPath, 'utf8'));
  const forbidden = new Set(['goal', 'prompt', 'input', 'output', 'secret', 'credential', 'authorization']);
  const seen = new Set();
  const found = [];
  function visit(node, location) {
    if (!node || typeof node !== 'object') return;
    if (node.$ref) {
      if (seen.has(node.$ref)) return;
      seen.add(node.$ref);
      visit(resolveRef(spec, node.$ref), node.$ref);
      return;
    }
    for (const key of Object.keys(node.properties || {})) {
      if (forbidden.has(key)) found.push(`${location}.${key}`);
      visit(node.properties[key], `${location}.${key}`);
    }
    visit(node.items, `${location}[]`);
    for (const [index, part] of (node.allOf || []).entries()) visit(part, `${location}.allOf[${index}]`);
  }
  for (const { route, method, operation } of operations(spec)) {
    for (const [status, responseRef] of Object.entries(operation.responses)) {
      if (!status.startsWith('2') || !responseRef.$ref) continue;
      const response = resolveRef(spec, responseRef.$ref);
      visit(response.content?.['application/json']?.schema, `${method} ${route}`);
    }
  }
  assert.deepEqual(found, []);
  assert.equal(spec.components.schemas.EnqueueRequest.properties.goal.writeOnly, true);
});

test('versioned and legacy prefixes are exact and both route without prefix confusion', async () => {
  assert.equal(matchApiPrefix('/api/v1/observability/events'), VERSIONED_PREFIX);
  assert.equal(matchApiPrefix('/api/observability/events'), PREFIX);
  assert.equal(matchApiPrefix('/api/v1/observability-evil/events'), null);
  assert.equal(matchApiPrefix('/api/observability-evil/events'), null);
  const calls = [];
  const service = new Proxy({}, { get: (_target, key) => input => {
    calls.push({ key, input });
    if (key === 'pageQueue') return { items: [], limit: 2, hasMore: false, nextCursor: null };
    if (key === 'listQueue') return [];
    if (key === 'queueSummary') return { workspaceId: 'ws-a', byStatus: {}, depth: 0 };
    return { items: [] };
  } });
  const writes = [];
  const router = createObservabilityHttpRouter({
    getService: () => service,
    parseJsonRequest: async () => null,
    writeJson: (_req, _res, status, body) => writes.push({ status, body }),
    denyIfUnauthorized: req => { req.huqanAuth = { subject: 'admin' }; return true; },
    authorizeWorkspace: () => ({ allowed: true }),
    rateLimiter: { check: () => ({ allowed: true }), acquireStream: () => ({ allowed: true, release() {} }) },
  });
  const req = () => Object.assign(new EventEmitter(), { method: 'GET', headers: {} });
  assert.equal(await router(req(), {}, new URL('http://local/api/v1/observability/queue?workspaceId=ws-a&limit=2')), true);
  assert.equal(await router(req(), {}, new URL('http://local/api/observability/queue?workspaceId=ws-a&limit=2')), true);
  assert.equal(calls.some(call => call.key === 'pageQueue'), true);
  assert.equal(calls.some(call => call.key === 'listQueue'), true);
  assert.equal(writes[0].body.data.limit, 2);
  assert.equal(writes[1].body.data.limit, undefined);
});

test('v1 time windows reject malformed and out-of-contract values', async () => {
  const writes = [];
  const router = createObservabilityHttpRouter({
    getService: () => ({}),
    parseJsonRequest: async () => null,
    writeJson: (_req, _res, status, body) => writes.push({ status, body }),
    denyIfUnauthorized: req => { req.huqanAuth = { subject: 'admin' }; return true; },
    authorizeWorkspace: () => ({ allowed: true }),
    rateLimiter: { check: () => ({ allowed: true }), acquireStream: () => ({ allowed: true, release() {} }) },
  });
  for (const windowMs of ['nope', '999', '2678400001']) {
    assert.equal(await router({ method: 'GET', headers: {} }, {}, new URL(`http://local/api/v1/observability/runs?workspaceId=ws-a&windowMs=${windowMs}`)), true);
  }
  assert.deepEqual(writes.map(item => item.status), [400, 400, 400]);
  assert.equal(writes.every(item => item.body.error.code === 'OBSERVABILITY_QUERY_INVALID'), true);
});

test('v1 not-found mutations use the standard error envelope', async () => {
  const writes = [];
  const router = createObservabilityHttpRouter({
    getService: () => ({ acknowledgeAlert: () => null, deleteAlertRule: () => false }),
    parseJsonRequest: async () => ({ workspaceId: 'ws-a' }),
    writeJson: (_req, _res, status, body) => writes.push({ status, body }),
    denyIfUnauthorized: req => { req.huqanAuth = { subject: 'admin' }; return true; },
    authorizeWorkspace: () => ({ allowed: true }),
    rateLimiter: { check: () => ({ allowed: true }), acquireStream: () => ({ allowed: true, release() {} }) },
  });
  await router({ method: 'POST', headers: {} }, {}, new URL('http://local/api/v1/observability/alerts/missing/acknowledge'));
  await router({ method: 'DELETE', headers: {} }, {}, new URL('http://local/api/v1/observability/alert-rules/missing?workspaceId=ws-a'));
  assert.deepEqual(writes.map(item => item.status), [404, 404]);
  for (const item of writes) {
    assert.equal(item.body.ok, false);
    assert.deepEqual(Object.keys(item.body), ['ok', 'error']);
    assert.match(item.body.error.code, /^OBSERVABILITY_/);
  }
});
