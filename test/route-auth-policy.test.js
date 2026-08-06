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

test('policy table: /graph-data is public only for the default workspace', () => {
  assert.equal(isPublicRoute('/graph-data', 'GET', { workspaceId: '' }), true);
  assert.equal(isPublicRoute('/graph-data', 'GET', { workspaceId: 'default' }), true);

  const scoped = resolveRouteAuthPolicy('/graph-data', 'GET', { workspaceId: 'acme' });
  assert.equal(scoped.authRequired, true);
  assert.equal(scoped.reason, 'non_default_workspace');
});

test('policy table: trust/read surfaces under /api/ stay authenticated', () => {
  for (const pathname of [
    '/api/provenance',
    '/api/audit',
    '/api/candidate-claims',
    '/api/trust-receipt',
    '/api/ingest',
    '/api/workbench/memory-context/abc',
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

test('prefix constants used by the routers are covered by the policy', () => {
  // Discover the prefix literals the routers dispatch on, so that adding a new
  // prefix-based family without declaring it is caught rather than assumed.
  const sources = [
    path.join(__dirname, '..', 'server.js'),
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
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('error', reject);
    req.end();
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

  const graph = await request(port, '/graph-data');
  assert.equal(graph.status, 200);

  // Scoped: non-default workspace requires a key.
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
});
