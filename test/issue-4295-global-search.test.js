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