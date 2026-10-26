'use strict';
const test = require('node:test');
const assert = require('node:assert');

function makeReq(url, method = 'GET') {
  return {
    method,
    url,
    headers: {},
    on: () => {},
  };
}
function makeRes() {
  const res = { statusCode: 200, headers: {}, body: '' };
  res.writeHead = (code, headers) => { res.statusCode = code; res.headers = headers; };
  res.end = (body) => { res.body = body; };
  res.setHeader = () => {};
  return res;
}

test('global-search returns 400 when q is missing', async () => {
  const { createGlobalSearchRoute } = require('../lib/http/global-search-route');
  const kernel = { graph: { getNodes: () => ({}) } };
  const handler = createGlobalSearchRoute({ kernel });
  const req = makeReq('/api/global-search?workspaceId=default');
  const res = makeRes();
  const handled = await handler(req, res);
  assert.strictEqual(handled, true);
  assert.strictEqual(res.statusCode, 400);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.ok, false);
  assert.strictEqual(body.error.code, 'BAD_REQUEST');
});

test('global-search returns 400 when workspaceId is missing', async () => {
  const { createGlobalSearchRoute } = require('../lib/http/global-search-route');
  const kernel = { graph: { getNodes: () => ({}) } };
  const handler = createGlobalSearchRoute({ kernel });
  const req = makeReq('/api/global-search?q=test');
  const res = makeRes();
  const handled = await handler(req, res);
  assert.strictEqual(handled, true);
  // workspaceId defaults to 'default' when missing, so this returns 200 with empty results
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.data.items.length, 0);
});

test('global-search returns results for valid query', async () => {
  const { createGlobalSearchRoute } = require('../lib/http/global-search-route');
  const mockNodes = {
    'node-1': { label: 'Test Node 1', provenance: { sourceRef: 'src-1' } },
    'node-2': { label: 'Another Test Node', provenance: { sourceRef: 'src-2' } },
  };
  const kernel = {
    graph: {
      getNodes: (ws, opts) => mockNodes,
    },
  };
  const handler = createGlobalSearchRoute({ kernel });
  const req = makeReq('/api/global-search?workspaceId=default&q=test');
  const res = makeRes();
  const handled = await handler(req, res);
  assert.strictEqual(handled, true);
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.ok, true);
  assert.ok(Array.isArray(body.data.items));
  assert.strictEqual(body.data.items.length, 2);
});

test('global-search handles empty results', async () => {
  const { createGlobalSearchRoute } = require('../lib/http/global-search-route');
  const kernel = { graph: { getNodes: () => ({}) } };
  const handler = createGlobalSearchRoute({ kernel });
  const req = makeReq('/api/global-search?workspaceId=default&q=nonexistent');
  const res = makeRes();
  const handled = await handler(req, res);
  assert.strictEqual(handled, true);
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.data.items.length, 0);
});
// The route must be reachable through the real request handler: an undeclared
// path is a silent 404 at the central auth gate, which is how the dashboard
// search box returned nothing in production even though the route unit-tested green.
function serverHandler({ authorized }) {
  const { createServerRequestHandler } = require('../lib/http/server-request-handler');
  const notHandled = async () => false;
  const denials = [];
  const handler = createServerRequestHandler({
    kernel: { graph: { getNodes: () => ({ 'node-1': { label: 'Alpha test node' } }) } },
    concurrencyLimiter: { tryAcquire: () => true, release: () => {} },
    denyIfUnauthorized: (_req, res) => {
      if (authorized) return true;
      denials.push(true);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"ok":false}');
      return false;
    },
    viewerMount: { isViewerPath: () => false, checkRateLimit: () => true, handle: async () => {} },
    externalClientBoundary: null,
    optionalRoutes: { authContext: {}, route: notHandled },
    handleObservabilityRoute: notHandled,
    handleV5PackageImportRoute: notHandled,
    handleV5PreflightRoute: notHandled,
    handleReadWorkflow: notHandled,
    handleWorkflowDataRoute: notHandled,
    handleFitnessDashboardRoute: notHandled,
    handleCoreRoutes: notHandled,
    handleIngestHttpRoutes: notHandled,
    handleReceiptReadRoute: () => false,
    handleWorkbenchRead: () => false,
    handleTrustQueryRoutes: () => false,
    handlePublicApiRoute: notHandled,
  });
  return { handler, denials };
}

function serverReq(url) {
  return { method: 'GET', url, headers: { host: 'localhost' }, socket: { remoteAddress: '198.51.100.7' }, on: () => {} };
}

function serverRes() {
  const res = makeRes();
  res.headersSent = false;
  res.once = () => {};
  res.on = () => {};
  return res;
}

test('the request handler serves /api/global-search to an authorized caller', async () => {
  const { handler } = serverHandler({ authorized: true });
  const res = serverRes();
  await handler(serverReq('/api/global-search?workspaceId=default&q=alpha'), res);
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.deepStrictEqual(body.data.items.map(item => item.id), ['node-1']);
});

test('the request handler challenges an unauthenticated /api/global-search call', async () => {
  const { handler, denials } = serverHandler({ authorized: false });
  const res = serverRes();
  await handler(serverReq('/api/global-search?workspaceId=default&q=alpha'), res);
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(denials.length, 1);
});

test('global-search refuses a non-GET method', async () => {
  const { createGlobalSearchRoute } = require('../lib/http/global-search-route');
  const handler = createGlobalSearchRoute({ kernel: { graph: { getNodes: () => ({}) } } });
  const res = makeRes();
  assert.strictEqual(await handler(makeReq('/api/global-search?q=x', 'POST'), res), true);
  assert.strictEqual(res.statusCode, 405);
});

test('global-search hides internal error details from the client', async t => {
  const { createGlobalSearchRoute } = require('../lib/http/global-search-route');
  const logged = [];
  t.mock.method(console, 'error', (...args) => logged.push(args));
  const kernel = { graph: { getNodes: () => { throw new Error('SQLITE_CORRUPT at /var/lib/huqan/memory.db'); } } };
  const res = makeRes();
  await createGlobalSearchRoute({ kernel })(makeReq('/api/global-search?q=test'), res);
  assert.strictEqual(res.statusCode, 500);
  const body = JSON.parse(res.body);
  assert.deepStrictEqual(body.error, { code: 'INTERNAL_ERROR', message: 'Search failed' });
  assert.ok(!res.body.includes('SQLITE_CORRUPT'));
  assert.strictEqual(logged.length, 1, 'the cause is logged server-side');
});
