'use strict';

/**
 * Issue #330 - central route authorization contract.
 *
 * Two guarantees are locked in here:
 *   1. Unit level: the policy table defaults to DENY, so an endpoint that
 *      nobody remembered to declare is authenticated rather than public.
 *   2. Runtime level: a real HTTP server rejects an undeclared route without
 *      credentials, and still serves the routes that are explicitly public.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const API_KEY = 'route-auth-policy-test-key';
process.env.AXIOM_API_KEY = API_KEY;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-330-'));
process.env.AXIOM_MEMORY_PATH = path.join(tmpDir, 'memory.json');
process.env.AXIOM_DB_PATH = path.join(tmpDir, 'memory.db');
process.env.AXIOM_OBSERVABILITY_AUTHZ_POLICY = JSON.stringify({ memberships: [{ subject: 'local-api-key', workspaceId: 'default', role: 'admin' }] });

const {
  resolveRouteAuthPolicy,
  isPublicRoute,
  PUBLIC_ROUTES,
} = require('../lib/http/route-auth-policy');

test('policy table: unknown routes are not challenged, they stay a generic 404', () => {
  const decision = resolveRouteAuthPolicy('/totally-new-endpoint', 'GET');
  assert.equal(decision.known, false);
  assert.equal(decision.reason, 'unknown_route');
  // Non-disclosure: an unrouted path must not answer 401, that would confirm
  // its existence to an unauthenticated caller.
  assert.equal(decision.authRequired, false);
  assert.equal(isPublicRoute('/totally-new-endpoint', 'GET'), false);
});

test('policy table: a declared endpoint is authenticated unless published', () => {
  const decision = resolveRouteAuthPolicy('/api/audit', 'GET');
  assert.equal(decision.known, true);
  assert.equal(decision.authRequired, true);
  assert.equal(decision.reason, 'declared_authenticated');
});

test('policy table: a public GET does not make POST on the same path public', () => {
  assert.equal(isPublicRoute('/v2-status', 'GET'), true);

  const post = resolveRouteAuthPolicy('/v2-status', 'POST');
  assert.equal(post.authRequired, true);
  assert.equal(post.reason, 'method_not_public');
});

test('policy table: /graph-data requires authentication for every workspace', () => {
  for (const workspaceId of ['', 'default', 'acme']) {
    const decision = resolveRouteAuthPolicy('/graph-data', 'GET', { workspaceId });
    assert.equal(decision.known, true);
    assert.equal(decision.authRequired, true);
    assert.equal(decision.reason, 'declared_authenticated');
    assert.equal(isPublicRoute('/graph-data', 'GET', { workspaceId }), false);
  }
});

test('policy table: trust/read surfaces under /api/ stay authenticated', () => {
  for (const pathname of [
    '/api/provenance',
    '/api/audit',
    '/api/candidate-claims',
    '/api/trust-receipt',
    '/api/ingest',
    '/api/workbench/memory-context/abc',
    '/api/workbench/activity',
  ]) {
    assert.equal(
      resolveRouteAuthPolicy(pathname, 'GET').authRequired,
      true,
      `${pathname} must require auth`,
    );
  }
});

test('policy table: every public route carries a written justification', () => {
  for (const rule of PUBLIC_ROUTES) {
    assert.ok(rule.why && rule.why.length > 20, `${rule.id} needs a 'why'`);
    assert.ok(Array.isArray(rule.methods) && rule.methods.length > 0, `${rule.id} needs methods`);
  }
});

test('policy table: trailing slash cannot bypass the deny default', () => {
  assert.equal(resolveRouteAuthPolicy('/api/audit/', 'GET').authRequired, true);
  assert.equal(isPublicRoute('/health/', 'GET'), true);
});

/**
 * The guard that actually prevents #330 from regressing.
 *
 * Every pathname literal that server.js dispatches on must appear in the policy
 * table. If someone adds a handler without declaring its authorization stance,
 * this fails instead of silently shipping an unreviewed surface.
 */
test('every route handled by server.js is declared in the policy table', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  const handled = new Set();
  for (const match of source.matchAll(/(?:reqUrl\.pathname|pathname)\s*===\s*'([^']+)'/g)) {
    handled.add(match[1]);
  }

  assert.ok(handled.size >= 15, `expected to discover server routes, found ${handled.size}`);

  const undeclared = [...handled].filter(
    (pathname) => resolveRouteAuthPolicy(pathname, 'GET').known !== true,
  );

  assert.deepEqual(
    undeclared,
    [],
    'these server.js routes are missing from lib/http/route-auth-policy.js: ' + undeclared.join(', '),
  );
});


test('prefix-dispatched route families are declared too', () => {
  // These surfaces are not reached by `pathname === '/x'`; they are matched by
  // prefix inside helper routers, so the scan above cannot see them. Pin them
  // explicitly: a sample path under each family must resolve as known + authed.
  const prefixFamilies = [
    '/api/trust-receipt/abc123',
    '/api/workbench/trust-receipt/abc123',
    '/api/workbench/memory-context/abc123',
  ];

  for (const pathname of prefixFamilies) {
    const decision = resolveRouteAuthPolicy(pathname, 'GET');
    assert.equal(decision.known, true, `${pathname} must be declared`);
    assert.equal(decision.authRequired, true, `${pathname} must require auth`);
  }
});

test('prefix rules do not match a longer path segment (#1229)', () => {
  for (const pathname of [
    '/api/v2/approvals',
    '/api/v2/approvals/request-1',
    '/api/v2/approvals/request-1/decision',
  ]) {
    const decision = resolveRouteAuthPolicy(pathname, 'GET');
    assert.equal(decision.known, true, `${pathname} must be declared`);
    assert.equal(decision.authRequired, true, `${pathname} must require auth`);
  }

  for (const pathname of [
    '/api/v2/approvalsXYZ',
    '/api/v2/approvalsXYZ/request-1',
  ]) {
    assert.deepEqual(resolveRouteAuthPolicy(pathname, 'GET'), {
      known: false,
      authRequired: false,
      ruleId: 'unknown',
      reason: 'unknown_route',
    });
  }
});

test('prefix constants used by the routers are covered by the policy', () => {
  // Discover the prefix literals the routers dispatch on, so that adding a new
  // prefix-based family without declaring it is caught rather than assumed.
  const sources = [
    path.join(__dirname, '..', 'server.js'),
    // TRUST_RECEIPT_READ_PREFIX lives here, not in server.js. If a prefix
    // constant moves to a new module, add that module to this list -- the
    // invariant is that every prefix the routers dispatch on is declared in
    // the policy, and this scan is what enforces it.
    path.join(__dirname, '..', 'lib', 'http-trust-query.js'),
    path.join(__dirname, '..', 'lib', 'workbench', 'trust-receipt-route.js'),
    path.join(__dirname, '..', 'lib', 'workbench', 'memory-context-route.js'),
  ];

  const prefixes = new Set();
  for (const file of sources) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/'(\/api\/[a-z0-9/-]*\/)'/gi)) {
      prefixes.add(match[1]);
    }
  }

  assert.ok(prefixes.size >= 3, `expected prefix constants, found ${prefixes.size}`);

  const undeclared = [...prefixes].filter(
    (prefix) => resolveRouteAuthPolicy(prefix + 'sample-id', 'GET').known !== true,
  );

  assert.deepEqual(
    undeclared,
    [],
    'these prefix families are missing from lib/http/route-auth-policy.js: ' + undeclared.join(', '),
  );
});
// --- runtime contract ---------------------------------------------------

function request(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'GET', headers },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function postJson(port, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: responseBody }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('runtime: undeclared route is denied without a key, declared public routes still work', async (t) => {
  const server = require('../server');
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });

  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  // The gate is enforced at runtime, not only by the static scan above: an
  // undeclared path is answered before dispatch, so a handler added without a
  // policy entry cannot execute unauthenticated.
  const undeclaredUnderApi = await request(port, '/api/definitely-not-declared');
  assert.equal(undeclaredUnderApi.status, 404, 'undeclared /api/ path must not leak existence');

  // An endpoint nobody declared stays a generic 404: it is neither served nor
  // confirmed to exist.
  const undeclared = await request(port, '/some-unreviewed-endpoint');
  assert.equal(undeclared.status, 404, 'undeclared route must stay 404, not leak via 401');

  // Declared-public routes are unaffected.
  const health = await request(port, '/health');
  assert.equal(health.status, 200);

  const status = await request(port, '/v2-status');
  assert.equal(status.status, 200);

  const api = await request(port, '/api?q=merhaba');
  assert.equal(api.status, 200);

  const capabilities = await request(port, '/api/v2/workflows');
  assert.equal(capabilities.status, 200);
  assert.equal(capabilities.headers['cache-control'], 'no-store');
  assert.equal(capabilities.headers['x-content-type-options'], 'nosniff');
  const observabilityOpenApi = await request(port, '/api/observability/openapi.json');
  assert.equal(observabilityOpenApi.status, 200);
  assert.equal(observabilityOpenApi.headers['cache-control'], 'no-store');
  assert.equal(observabilityOpenApi.headers['x-content-type-options'], 'nosniff');
  assert.equal(JSON.parse(observabilityOpenApi.body).info.version, '1.0.0');

  const observabilityDenied = await request(port, '/api/observability/v1/events?workspaceId=default');
  assert.equal(observabilityDenied.status, 401);
  assert.equal(JSON.parse(observabilityDenied.body).error.code, 'UNAUTHORIZED');
  const observabilityEvents = await request(port, '/api/observability/v1/events?workspaceId=default', {
    Authorization: `Bearer ${API_KEY}`,
  });
  assert.equal(observabilityEvents.status, 200);
  assert.equal(JSON.parse(observabilityEvents.body).ok, true);

  const capabilityBody = JSON.parse(capabilities.body);
  assert.match(capabilityBody.contractVersion, /^\d+\.\d+\.\d+$/);
  assert.ok(capabilityBody.workflows.some(item => item.workflowId === 'verify' && item.availability.api === true));
  assert.ok(capabilityBody.workflows.some(item => item.workflowId === 'ask' && item.availability.api === true));

  const unsupported = await request(port, '/api?q=plan:test');
  assert.equal(unsupported.status, 403);
  const unsupportedBody = JSON.parse(unsupported.body);
  assert.equal(unsupportedBody.status, 'capability_not_available');
  assert.equal(unsupportedBody.error.code, 'UNSUPPORTED_WORKFLOW');
  assert.equal(typeof unsupportedBody.traceId, 'string');

  const graph = await request(port, '/graph-data');
  assert.equal(graph.status, 401);

  const defaultWithKey = await request(port, '/graph-data', {
    Authorization: `Bearer ${API_KEY}`,
  });
  assert.notEqual(defaultWithKey.status, 401);

  const scoped = await request(port, '/graph-data?workspaceId=acme');
  assert.equal(scoped.status, 401);

  const scopedWithKey = await request(port, '/graph-data?workspaceId=acme', {
    Authorization: `Bearer ${API_KEY}`,
  });
  assert.notEqual(scopedWithKey.status, 401);

  // Prefix-dispatched families are challenged, not served, without a key.
  for (const prefixed of [
    '/api/trust-receipt/abc',
    '/api/workbench/trust-receipt/abc',
    '/api/workbench/memory-context/abc',
  ]) {
    const res = await request(port, prefixed);
    assert.equal(res.status, 401, prefixed + ' must require a key');
  }

  // Authenticated surface stays authenticated.
  const audit = await request(port, '/api/audit?targetId=x');
  assert.equal(audit.status, 401);

  const auth = { Authorization: `Bearer ${API_KEY}` };
  for (const pathname of [
    '/api/audit?targetId=x',
    '/api/trust-receipt?targetId=x',
    '/api/trust-receipt/abc',
    '/api/workbench/trust-receipt/abc',
    '/api/workbench/receipt-bundle',
  ]) {
    const missingWorkspace = await request(port, pathname, auth);
    assert.equal(missingWorkspace.status, 400, `${pathname} must require an exact workspace`);
  }

  const repeatedWorkspace = await request(
    port,
    '/api/audit?targetId=x&workspaceId=workspace-a&workspaceId=workspace-b',
    auth,
  );
  assert.equal(repeatedWorkspace.status, 400);

  const spoofedActor = await postJson(port, '/upload', {
    text: 'actor spoof test',
    workspaceId: 'workspace-a',
    actor: 'admin',
  }, auth);
  assert.equal(spoofedActor.status, 400);
  assert.equal(JSON.parse(spoofedActor.body).error.code, 'ACTOR_MISMATCH');

  const spoofedProvenanceActor = await postJson(port, '/upload', {
    text: 'provenance actor spoof test',
    workspaceId: 'workspace-a',
    actor: 'http-api',
    provenance: { actor: 'admin' },
  }, auth);
  assert.equal(spoofedProvenanceActor.status, 400);
  assert.equal(JSON.parse(spoofedProvenanceActor.body).error.code, 'ACTOR_MISMATCH');
});
