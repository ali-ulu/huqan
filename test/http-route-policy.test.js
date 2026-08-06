'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  AUTH_REQUIRED,
  AUTH_PUBLIC,
  ROUTE_POLICIES,
  ROUTE_PREFIX_POLICIES,
  resolveRoutePolicy,
  isListedRoute,
  requiresAuth,
} = require('../lib/http-route-policy');

const SERVER_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

/**
 * Every exact pathname server.js dispatches on. This is the list that must
 * stay in sync with the policy table -- it is what makes forgetting auth on a
 * new endpoint a build failure instead of a silent hole.
 */
function declaredServerRoutes() {
  const routes = new Set();
  const pattern = /reqUrl\.pathname\s*===\s*'([^']+)'/g;
  let match;
  while ((match = pattern.exec(SERVER_SOURCE)) !== null) {
    routes.add(match[1]);
  }
  return [...routes].sort();
}

// ─── the invariant this issue asks for ───────────────────────────────────────

test('server.js declares routes, and the scan finds them', () => {
  const routes = declaredServerRoutes();
  assert.ok(routes.length >= 10,
    `expected to find server routes; found ${routes.length}. If route dispatch was refactored, this scan must be updated or the policy invariant silently stops being enforced.`);
});

test('every route server.js serves has an explicit policy entry', () => {
  const unlisted = declaredServerRoutes().filter((route) => !isListedRoute(route));
  assert.deepEqual(unlisted, [],
    `these routes have no entry in lib/http-route-policy.js: ${unlisted.join(', ')}. Add one with an explicit auth decision and a reason.`);
});

test('a hypothetical new route is closed until it is listed', () => {
  const policy = resolveRoutePolicy('/api/some-brand-new-endpoint');
  assert.equal(policy.listed, false);
  assert.equal(policy.auth, AUTH_REQUIRED, 'the default must be closed, not open');
});

// ─── public routes are decisions, not defaults ───────────────────────────────

test('every public route states why it is public', () => {
  for (const [route, policy] of Object.entries(ROUTE_POLICIES)) {
    if (policy.auth !== AUTH_PUBLIC) continue;
    assert.ok(policy.reason && policy.reason.length > 10,
      `${route} is public without a stated reason`);
  }
});

test('public routes that reveal instance data record that disclosure', () => {
  // These three are the conscious decisions #330 asked for. They stay public
  // because the bundled dashboard calls them without a key, and the cost is
  // recorded rather than left implicit.
  for (const route of ['/v2-status', '/graph-data', '/api']) {
    const policy = resolveRoutePolicy(route);
    assert.equal(policy.auth, AUTH_PUBLIC);
    assert.ok(policy.disclosure, `${route} is public and should record what it discloses`);
  }
});

test('every policy entry declares a valid auth mode', () => {
  for (const [route, policy] of Object.entries(ROUTE_POLICIES)) {
    assert.ok([AUTH_REQUIRED, AUTH_PUBLIC].includes(policy.auth), `${route} has an invalid auth mode`);
  }
  for (const entry of ROUTE_PREFIX_POLICIES) {
    assert.ok([AUTH_REQUIRED, AUTH_PUBLIC].includes(entry.auth), `${entry.prefix} has an invalid auth mode`);
  }
});

// ─── mutating surfaces must not be public ────────────────────────────────────

test('ingest and approval surfaces require auth', () => {
  for (const route of [
    '/api/ingest', '/api/ingest/status', '/api/ingest/approvals',
    '/yukle', '/upload', '/api/provenance', '/api/audit',
    '/api/candidate-claims', '/api/trust-receipt',
  ]) {
    assert.equal(requiresAuth(route), true, `${route} must require auth`);
  }
});

test('the workbench prefix requires auth for every sub-path', () => {
  assert.equal(requiresAuth('/api/workbench/memory-context/abc'), true);
  assert.equal(requiresAuth('/api/workbench/trust-receipt/xyz'), true);
});

// ─── resolution behavior ─────────────────────────────────────────────────────

test('exact matches win over prefix matches', () => {
  assert.equal(resolveRoutePolicy('/health').reason, ROUTE_POLICIES['/health'].reason);
});

test('malformed input resolves closed rather than throwing', () => {
  for (const value of [undefined, null, 42, {}, '']) {
    const policy = resolveRoutePolicy(value);
    assert.equal(policy.auth, AUTH_REQUIRED);
    assert.equal(policy.listed, false);
  }
});

test('a prefix policy does not leak to a similar-looking path', () => {
  assert.equal(isListedRoute('/api/workbenchsomething'), false,
    'prefix matching must not swallow a neighbouring path');
});

// ─── the wiring is actually present in server.js ─────────────────────────────

test('server.js applies the central policy before its route chain', () => {
  assert.match(SERVER_SOURCE, /require\('\.\/lib\/http-route-policy'\)/,
    'server.js must import the policy table');
  assert.match(SERVER_SOURCE, /resolveRoutePolicy\(reqUrl\.pathname\)/,
    'server.js must resolve a policy for the incoming path');
  assert.match(SERVER_SOURCE, /routePolicy\.listed && routePolicy\.auth === AUTH_REQUIRED/,
    'the central check must gate on both listedness and the required mode');
});

test('the central check does not turn unknown paths into 401', () => {
  // Unknown paths must keep returning the generic 404; answering 401 would
  // disclose which paths exist and would break the reserved-route contract
  // tests that assert a plain 404.
  assert.match(SERVER_SOURCE, /routePolicy\.listed &&/,
    'the central check must be conditioned on the route being listed');
});
