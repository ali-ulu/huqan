'use strict';

// #2788 Phase 2: GET /api/claim-read mounts lib/claim-read.js's readClaim()
// over HTTP via lib/http/claim-read-route.js. Mirrors test/trust-query-routes.test.js's
// mount-level shape (fake req/res, no real HTTP server) but builds a real
// contested state through the same Kernel/routeCandidateClaim path
// lib/claim-read.test.js and lib/conflict-candidate-review.test.js use,
// rather than a hand-written candidate fixture.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Kernel = require('../kernel');
const { routeCandidateClaim } = require('../lib/conflict-detector');
const { createClaimReadRoute } = require('../lib/http/claim-read-route');
const { readClaimReadIntent } = require('../lib/http-trust-query');
const { readExactWorkspace } = require('../lib/http/exact-workspace');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-claim-read-route-'));

test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeProvenance(overrides = {}) {
  return {
    provenanceId: 'prov-claim-001',
    sourceRef: 'docs/claims.md#1',
    sourceTitle: 'Claims',
    sourceType: 'document',
    actor: 'builder',
    timestamp: '2026-06-02T00:00:00Z',
    confidence: 0.91,
    workspaceId: 'workspace-a',
    trustPolicyVersion: '0.8.0',
    ...overrides,
  };
}

function routeKernelCandidate(kernel, claim, opts = {}) {
  const admissionOwner = kernel.kernel || kernel;
  return routeCandidateClaim(kernel, claim, opts, {
    evaluateLearnAdmission: (text, admissionOpts, provenance, workspaceId) =>
      admissionOwner._evaluateLearnAdmission(text, admissionOpts, provenance, workspaceId),
  });
}

function buildContestedKernel(name) {
  const kernel = new Kernel({ noLoad: true, useSQLite: false, memoryPath: path.join(tempDir, `${name}.json`) });
  const edgeProvenance = makeProvenance({ provenanceId: 'prov-edge-001' });
  kernel.graph.addNode('fire', 'fire', edgeProvenance, { workspaceId: 'workspace-a' });
  kernel.graph.addNode('smoke', 'smoke', edgeProvenance, { workspaceId: 'workspace-a' });
  kernel.graph.addEdge('fire', 'smoke', 'CAUSES', {
    workspaceId: 'workspace-a',
    provenance: edgeProvenance,
    strength: 0.9,
    confidence: 0.88,
    source: 'manual',
    sourceRef: edgeProvenance.sourceRef,
    evidence: ['fire causes smoke'],
  });

  const routed = routeKernelCandidate(kernel, {
    claim: 'fire prevents smoke',
    subject: 'fire',
    relation: 'PREVENTS',
    object: 'smoke',
    provenance: makeProvenance({ provenanceId: 'prov-challenge-001', sourceRef: 'docs/claims.md#2' }),
  }, { workspaceId: 'workspace-a' });

  assert.strictEqual(routed.conflict.conflict, true, 'setup: candidate must actually conflict');
  return kernel;
}

function fakeRes(captured) {
  return {
    writeHead(status, headers) { captured.status = status; captured.headers = headers; },
    end(body) { captured.body = body; },
  };
}

function mountWith(graph, stubs = {}) {
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
  const mount = createClaimReadRoute({
    graph,
    writeJson,
    writeApiError: apiError,
    denyIfUnauthorized: stubs.denyIfUnauthorized || (() => true),
    readExactWorkspace,
    readClaimReadIntent,
    writeStructuredLog: () => {},
  });
  return { mount, calls };
}

const reqUrl = (search = '') => ({ pathname: '/api/claim-read', searchParams: new URLSearchParams(search) });

test('mount ignores paths it does not own', () => {
  const { mount } = mountWith({});
  const captured = {};
  assert.equal(mount.handleClaimReadRoute({ method: 'GET' }, fakeRes(captured), { pathname: '/api/other', searchParams: new URLSearchParams() }, {}), false);
  assert.equal(captured.status, undefined);
});

test('non-GET is 405', () => {
  const { mount, calls } = mountWith({});
  const captured = {};
  const handled = mount.handleClaimReadRoute({ method: 'POST' }, fakeRes(captured), reqUrl(), {});
  assert.equal(handled, true);
  assert.deepEqual(calls, [['apiError', 405, 'METHOD_NOT_ALLOWED']]);
});

test('denied auth short-circuits before any read', () => {
  const { mount, calls } = mountWith({}, { denyIfUnauthorized: () => false });
  const captured = {};
  const handled = mount.handleClaimReadRoute({ method: 'GET' }, fakeRes(captured), reqUrl('workspaceId=default&targetId=x'), {});
  assert.equal(handled, true);
  assert.equal(calls.length, 0);
});

test('missing workspaceId is 400', () => {
  const { mount, calls } = mountWith({});
  const captured = {};
  const handled = mount.handleClaimReadRoute({ method: 'GET' }, fakeRes(captured), reqUrl('targetId=x'), {});
  assert.equal(handled, true);
  assert.deepEqual(calls, [['apiError', 400, 'MISSING_WORKSPACE_ID']]);
});

test('missing targetId is 400', () => {
  const { mount, calls } = mountWith({});
  const captured = {};
  const handled = mount.handleClaimReadRoute({ method: 'GET' }, fakeRes(captured), reqUrl('workspaceId=default'), {});
  assert.equal(handled, true);
  assert.deepEqual(calls, [['apiError', 400, 'INVALID_QUERY']]);
});

test('settled read for an uncontested target', () => {
  const kernel = new Kernel({ noLoad: true, useSQLite: false, memoryPath: path.join(tempDir, 'settled.json') });
  const provenance = makeProvenance();
  kernel.graph.addNode('calm', 'calm', provenance, { workspaceId: 'workspace-a' });
  const { mount } = mountWith(kernel.graph);
  const captured = {};
  const handled = mount.handleClaimReadRoute({ method: 'GET' }, fakeRes(captured), reqUrl('workspaceId=workspace-a&targetId=calm'), {});
  assert.equal(handled, true);
  const body = JSON.parse(captured.body);
  assert.equal(captured.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.kind, 'settled');
  assert.ok(body.data.value);
});

test('LOW risk (category=READ_ONLY) returns contested_marker with both sides', () => {
  const kernel = buildContestedKernel('http-low');
  const { mount } = mountWith(kernel.graph);
  const captured = {};
  mount.handleClaimReadRoute({ method: 'GET' }, fakeRes(captured), reqUrl('workspaceId=workspace-a&targetId=fire&category=READ_ONLY'), {});
  const body = JSON.parse(captured.body).data;
  assert.equal(body.kind, 'unsettled');
  assert.equal(body.behavior, 'contested_marker');
  assert.equal(body.reader.riskLevel, 'LOW');
  assert.equal('value' in body, false);
  assert.ok(body.sides.canonical);
  assert.equal(body.sides.challengers.length, 1);
});

test('MEDIUM risk (category=NETWORK_CALL) returns last_known_good', () => {
  const kernel = buildContestedKernel('http-medium');
  const { mount } = mountWith(kernel.graph);
  const captured = {};
  mount.handleClaimReadRoute({ method: 'GET' }, fakeRes(captured), reqUrl('workspaceId=workspace-a&targetId=fire&category=NETWORK_CALL'), {});
  const body = JSON.parse(captured.body).data;
  assert.equal(body.kind, 'unsettled');
  assert.equal(body.behavior, 'last_known_good');
  assert.equal(body.reader.riskLevel, 'MEDIUM');
  assert.ok(body.lastKnownGood);
  assert.equal('sides' in body, false);
});

test('HIGH risk (category=CANONICAL_GRAPH_WRITE) returns block with a minimal receipt, no challenger text', () => {
  const kernel = buildContestedKernel('http-high');
  const { mount } = mountWith(kernel.graph);
  const captured = {};
  mount.handleClaimReadRoute({ method: 'GET' }, fakeRes(captured), reqUrl('workspaceId=workspace-a&targetId=fire&category=CANONICAL_GRAPH_WRITE'), {});
  const body = JSON.parse(captured.body).data;
  assert.equal(body.kind, 'unsettled');
  assert.equal(body.behavior, 'block');
  assert.equal(body.reader.riskLevel, 'HIGH');
  assert.equal('value' in body, false);
  assert.equal('lastKnownGood' in body, false);
  assert.equal('sides' in body, false);
  assert.deepEqual(Object.keys(body.receipt).sort(), ['id', 'status']);
  assert.ok(!captured.body.includes('fire prevents smoke'), 'a blocked response must not leak the challenger claim text');
});

test('riskScore query param resolves a risk level directly', () => {
  const kernel = buildContestedKernel('http-score');
  const { mount } = mountWith(kernel.graph);
  const captured = {};
  mount.handleClaimReadRoute({ method: 'GET' }, fakeRes(captured), reqUrl('workspaceId=workspace-a&targetId=fire&riskScore=90'), {});
  const body = JSON.parse(captured.body).data;
  assert.equal(body.reader.riskLevel, 'CRITICAL');
  assert.equal(body.behavior, 'block');
});

test('missing intent is a fail-safe block', () => {
  const kernel = buildContestedKernel('http-noindent');
  const { mount } = mountWith(kernel.graph);
  const captured = {};
  mount.handleClaimReadRoute({ method: 'GET' }, fakeRes(captured), reqUrl('workspaceId=workspace-a&targetId=fire'), {});
  const body = JSON.parse(captured.body).data;
  assert.equal(body.behavior, 'block');
  assert.equal(body.reason, 'intent_absent');
});

test('server.js mounts the route through trust-query-routes, not directly', () => {
  // Kept off server.js's own fan-out (which is at its line-budget ceiling):
  // lib/http/trust-query-routes.js requires this module and folds
  // handleClaimReadRoute into the single handleTrustQueryRoutes it already
  // returns, so server.js's one existing require/mount line covers both.
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const dispatcherSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'http', 'server-request-handler.js'), 'utf8');
  assert.ok(!serverSource.includes("require('./lib/http/claim-read-route')"), 'server.js does not require this module directly');
  assert.ok(dispatcherSource.includes('if (handleTrustQueryRoutes(req, res, reqUrl, correlation)) return;'), 'dispatcher delegates through the existing mount');

  const mountSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'http', 'trust-query-routes.js'), 'utf8');
  assert.ok(mountSource.includes("require('./claim-read-route')"), 'trust-query-routes mounts the claim-read route');
  assert.ok(mountSource.includes('handleClaimReadRoute(req, res, reqUrl, correlation)'), 'trust-query-routes delegates to it');
});
