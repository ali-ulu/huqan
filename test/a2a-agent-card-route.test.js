'use strict';

/**
 * Route-boundary contract for GET /.well-known/agent-card.json (P0-C).
 *
 * The property under test is not "a card is returned". It is that the card
 * cannot say more than the deployment does. Three ways it could:
 *
 *   - by naming an identity the exchange route would not accept as its target;
 *   - by advertising a capability on a deployment where that route is absent;
 *   - by implying, through a `.well-known` path, that it is public.
 *
 * Each has a test below. The identity assertions read from the same fixture the
 * exchange tests use, so a card that drifted from the evaluator's binding would
 * fail here rather than in production.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildFixture } = require('../scripts/a2a-conformance/run.js');
const { resolveRouteAuthPolicy } = require('../lib/http/route-auth-policy');
const { CANONICAL_WORKSPACE } = require('../lib/a2a/exchange-route');
const { buildAgentCard, PROTOCOL_VERSION, UNSUPPORTED_SURFACES } = require('../lib/a2a/agent-card');
const {
  AGENT_CARD_PATH,
  AGENT_CARD_ROUTE_ERRORS,
  createAgentCardBoundary,
} = require('../lib/a2a/agent-card-route');

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-a2a-card-'));
  const replayDirectory = path.join(root, 'replay');
  fs.mkdirSync(replayDirectory);
  return { root, replayDirectory };
}

function writeAuthority(root, authority) {
  const file = path.join(root, 'authority.json');
  fs.writeFileSync(file, JSON.stringify(authority), 'utf8');
  return file;
}

function freshBoundary() {
  const { root, replayDirectory } = makeSandbox();
  const fixture = buildFixture(CANONICAL_WORKSPACE);
  const authorityFile = writeAuthority(root, fixture.authority);
  const boundary = createAgentCardBoundary({ authorityFile, replayDirectory });
  return { boundary, fixture, root, replayDirectory, authorityFile };
}

/** Mount the boundary the way server.js does, so dispatch is the real shape. */
async function withServer(boundary, run) {
  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url, 'http://127.0.0.1');
    if (boundary && boundary.route(req, res, reqUrl)) return;
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function request(port, { method = 'GET', requestPath = AGENT_CARD_PATH } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: requestPath, method,
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch (_) { parsed = null; }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('agent card: the served identity is the one the exchange binds against', async () => {
  const { boundary, fixture } = freshBoundary();
  assert.ok(boundary, 'boundary must exist when authority and replay dir are configured');

  const response = await withServer(boundary, (port) => request(port));

  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');

  // Not a hand-written expectation: expectedTarget is the record
  // lib/a2a/bounded-exchange.js rejects a mismatched target against.
  const target = fixture.authority.expectedTarget;
  assert.deepEqual(response.body.agent, {
    agentId: target.agentId,
    identityRef: target.identityRef,
    identityHash: target.identityHash,
    workspaceId: target.workspaceId,
  });
  assert.equal(response.body.receiverAuthorityId, fixture.authority.authorityId);
  assert.equal(response.body.protocolVersion, PROTOCOL_VERSION);
});

test('agent card: it advertises the exchange route and nothing else', async () => {
  const { boundary } = freshBoundary();
  const response = await withServer(boundary, (port) => request(port));

  assert.deepEqual(response.body.capabilities.map((entry) => entry.id), ['bounded-exchange']);
  assert.equal(response.body.capabilities[0].path, '/api/a2a/exchange');
  assert.equal(response.body.capabilities[0].method, 'POST');
});

test('agent card: absent P0 surfaces are named rather than omitted', async () => {
  const { boundary } = freshBoundary();
  const response = await withServer(boundary, (port) => request(port));

  // These are the units the P0 scope freeze still defers (P0-F, P0-G) plus
  // idempotency keys, which P0-E deliberately did not ship. Shipping one
  // without removing its line here would leave the card claiming less than the
  // deployment does, which is the mirror of the failure this route guards.
  for (const surface of ['idempotency-keys', 'cancellation', 'streaming', 'json-rpc']) {
    assert.ok(response.body.unsupported.includes(surface), `${surface} must be declared unsupported`);
  }
  assert.deepEqual(response.body.unsupported, [...UNSUPPORTED_SURFACES]);

  // Each of these left the list when its unit shipped. The exact-list assertion
  // above is what forced those edits rather than letting the card go stale.
  assert.ok(!response.body.unsupported.includes('capability-negotiation'), 'shipped in P0-D');
  assert.ok(!response.body.unsupported.includes('task-lifecycle'), 'shipped in P0-E');

  // `idempotency-keys` stayed on purpose: a caller-supplied key would have to
  // return a stored success for a retried request, and the case where that is
  // unknowable is the case the replay marker exists for.
  assert.ok(response.body.unsupported.includes('idempotency-keys'));
});

test('agent card: it advertises the task states a consumer must handle', async () => {
  const { boundary } = freshBoundary();
  const response = await withServer(boundary, (port) => request(port));

  assert.equal(response.body.tasks.pathPrefix, '/api/a2a/tasks/');
  assert.equal(response.body.tasks.method, 'GET');
  // `unknown` is advertised because a consumer that has not been told it exists
  // will treat it as an error and retry -- which is what at-most-once protects
  // against.
  assert.deepEqual(response.body.tasks.states, ['completed', 'unknown']);
});

test('agent card: it points at the negotiation route it actually serves', async () => {
  const { boundary } = freshBoundary();
  const response = await withServer(boundary, (port) => request(port));

  assert.equal(response.body.negotiation.path, '/api/a2a/negotiate');
  assert.equal(response.body.negotiation.method, 'POST');
  assert.deepEqual(response.body.negotiation.protocolVersions, [PROTOCOL_VERSION]);

  // Negotiation is the mechanism for agreeing on capabilities, not one of the
  // capabilities that can be agreed on.
  assert.ok(!response.body.capabilities.some((entry) => entry.id === 'capability-negotiation'));
});

test('agent card: it declares itself authenticated', async () => {
  const { boundary } = freshBoundary();
  const response = await withServer(boundary, (port) => request(port));

  assert.deepEqual(response.body.authentication, { required: true, scheme: 'api-key' });
});

test('agent card: the well-known path is authenticated, not public', () => {
  const enabled = resolveRouteAuthPolicy(AGENT_CARD_PATH, 'GET', { a2aAgentCardRouteEnabled: true });
  assert.equal(enabled.known, true);
  assert.equal(enabled.authRequired, true, 'a .well-known path must not inherit public by convention');
  assert.equal(enabled.ruleId, 'a2a-agent-card');
});

test('agent card: an unconfigured deployment answers 404, never 401', () => {
  // Same non-disclosure property the exchange route has: a 401 on an unserved
  // path would confirm the surface exists on this deployment.
  const disabled = resolveRouteAuthPolicy(AGENT_CARD_PATH, 'GET', {});
  assert.equal(disabled.known, false);
  assert.equal(disabled.authRequired, false);
  assert.equal(disabled.ruleId, 'unknown');
});

test('agent card: no card is served without the configuration the capability needs', () => {
  assert.equal(createAgentCardBoundary({}), null);
  assert.equal(createAgentCardBoundary({ authorityFile: '/nonexistent/authority.json', replayDirectory: os.tmpdir() }), null);

  // The authority alone is not enough. The advertised capability is unreachable
  // without the replay owner, so a card here would name a route that 404s.
  const { root, replayDirectory } = makeSandbox();
  const authorityFile = writeAuthority(root, buildFixture(CANONICAL_WORKSPACE).authority);
  assert.equal(createAgentCardBoundary({ authorityFile, replayDirectory: '' }), null);
  assert.ok(createAgentCardBoundary({ authorityFile, replayDirectory }));
});

test('agent card: a relative or symlinked authority path is refused', () => {
  const { root, replayDirectory } = makeSandbox();
  const real = writeAuthority(root, buildFixture(CANONICAL_WORKSPACE).authority);

  assert.equal(createAgentCardBoundary({ authorityFile: 'authority.json', replayDirectory }), null);

  const link = path.join(root, 'authority-link.json');
  fs.symlinkSync(real, link);
  assert.equal(createAgentCardBoundary({ authorityFile: link, replayDirectory }), null);
});

test('agent card: a write method is refused', async () => {
  const { boundary } = freshBoundary();
  const response = await withServer(boundary, (port) => request(port, { method: 'POST' }));

  assert.equal(response.status, 405);
  assert.equal(response.body.decision, 'block');
  assert.equal(response.body.reason, AGENT_CARD_ROUTE_ERRORS.METHOD);
});

test('agent card: an authority that cannot describe this agent yields no card', () => {
  const fixture = buildFixture(CANONICAL_WORKSPACE);

  assert.equal(buildAgentCard(null), null);
  assert.equal(buildAgentCard({}), null);
  assert.equal(buildAgentCard({ ...fixture.authority, expectedTarget: undefined }), null);
  assert.equal(buildAgentCard({ ...fixture.authority, authorityId: '' }), null);

  // A partial card is worse than none: a consumer would cache it.
  const missingHash = JSON.parse(JSON.stringify(fixture.authority));
  missingHash.expectedTarget.identityHash = '';
  assert.equal(buildAgentCard(missingHash), null);
});

test('agent card: the boundary ignores every other path', async () => {
  const { boundary } = freshBoundary();
  const response = await withServer(boundary, (port) => request(port, { requestPath: '/.well-known/other.json' }));

  assert.equal(response.status, 404);
});
