'use strict';

// #2128 slice 2: the four trust query routes moved from server.js to
// lib/http/trust-query-routes.js. server.test.js covers the 200 paths over
// HTTP; this pins the mount contract the move introduced: path matching,
// method gating, auth short-circuit, and the thin server.js call site.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTrustQueryRoutes } = require('../lib/http/trust-query-routes');
const { readTrustFilters, hasTrustQuery } = require('../lib/http-trust-query');

function fakeRes(captured) {
  return {
    writeHead(status, headers) { captured.status = status; captured.headers = headers; },
    end(body) { captured.body = body; },
  };
}

function mountWith(stubs = {}) {
  const calls = [];
  const apiError = (req, res, status, code, message) => {
    calls.push(['apiError', status, code]);
    res.writeHead(status, {});
    res.end(JSON.stringify({ ok: false, error: { code, message } }));
  };
  const writeJson = (req, res, status, payload) => {
    calls.push(['json', status]);
    res.writeHead(status, {});
    res.end(JSON.stringify(payload));
  };
  const mount = createTrustQueryRoutes({
    graph: {},
    writeJson,
    writeApiError: apiError,
    denyIfUnauthorized: stubs.denyIfUnauthorized || (() => true),
    readExactWorkspace: require('../lib/http/exact-workspace').readExactWorkspace,
    readTrustFilters,
    hasTrustQuery,
    writeStructuredLog: () => {},
  });
  return { mount, calls };
}

const reqUrl = (pathname, search = '') => ({ pathname, searchParams: new URLSearchParams(search) });

test('#2128: mount ignores paths it does not own', () => {
  const { mount } = mountWith();
  const captured = {};
  assert.equal(mount.handleTrustQueryRoutes({ method: 'GET' }, fakeRes(captured), reqUrl('/api/other'), {}), false);
  assert.equal(captured.status, undefined);
});

test('#2128: non-GET to an owned path is 405', () => {
  const { mount, calls } = mountWith();
  const captured = {};
  const handled = mount.handleTrustQueryRoutes({ method: 'POST' }, fakeRes(captured), reqUrl('/api/provenance'), {});
  assert.equal(handled, true);
  assert.deepEqual(calls, [['apiError', 405, 'METHOD_NOT_ALLOWED']]);
});

test('#2128: denied auth short-circuits before any query', () => {
  const { mount, calls } = mountWith({ denyIfUnauthorized: () => false });
  const captured = {};
  const handled = mount.handleTrustQueryRoutes({ method: 'GET' }, fakeRes(captured), reqUrl('/api/provenance', 'targetId=kedi'), {});
  assert.equal(handled, true);
  assert.equal(calls.length, 0);
});

test('#2128: empty query is INVALID_QUERY without touching the graph', () => {
  const { mount, calls } = mountWith();
  const captured = {};
  const handled = mount.handleTrustQueryRoutes({ method: 'GET' }, fakeRes(captured), reqUrl('/api/candidate-claims'), {});
  assert.equal(handled, true);
  assert.deepEqual(calls, [['apiError', 400, 'INVALID_QUERY']]);
});

test('#2128: server.js routes the four paths through the mount', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const dispatcherSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'http', 'server-request-handler.js'), 'utf8');
  assert.ok(source.includes("require('./lib/http/trust-query-routes')"), 'server requires the mount');
  assert.ok(!source.includes("require('./lib/provenance-query')"), 'provenance-query require moved out with its uses');
  assert.ok(dispatcherSource.includes('if (handleTrustQueryRoutes(req, res, reqUrl, correlation)) return;'), 'dispatcher delegates');
  // #2788 Phase 2: /api/claim-read (lib/http/claim-read-route.js) mounts
  // through this same module rather than a second server.js require, so the
  // new route does not add to server.js's own fan-out.
  assert.ok(!source.includes("require('./lib/http/claim-read-route')"), 'claim-read route is not required directly by server.js');
  for (const gone of ['queryProvenance(', 'queryAuditTrailPage(', 'queryCandidateClaims(', 'buildTrustReceipt(']) {
    assert.ok(!source.includes(gone), `query call moved out of server.js (${gone})`);
  }
});
