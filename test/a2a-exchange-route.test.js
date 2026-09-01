'use strict';

/**
 * Route-boundary contract for POST /api/a2a/exchange (P0-B).
 *
 * The bounded exchange rules were already covered by `npm run conformance:a2a`,
 * which drives the evaluator through a child process. What was never covered is
 * the part this gate added: that a real HTTP request reaches those rules, and
 * that the transport in front of them refuses on its own terms without
 * softening any of the evaluator's answers.
 *
 * Exchanges are built by the conformance harness's own generator rather than
 * hand-rolled here. A second generator would let this file pass against an
 * envelope the conformance suite would never produce.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildFixture } = require('../scripts/a2a-conformance/run.js');
const { readJsonBody } = require('../requestGuards');
const { resolveRouteAuthPolicy } = require('../lib/http/route-auth-policy');
const {
  A2A_ROUTE_ERRORS,
  CANONICAL_WORKSPACE,
  createA2aExchangeBoundary,
} = require('../lib/a2a/exchange-route');

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-a2a-route-'));
  const replayDirectory = path.join(root, 'replay');
  fs.mkdirSync(replayDirectory);
  return { root, replayDirectory };
}

function writeAuthority(root, authority) {
  const file = path.join(root, 'authority.json');
  fs.writeFileSync(file, JSON.stringify(authority), 'utf8');
  return file;
}

/**
 * Mount the boundary exactly the way server.js does, so the test exercises the
 * real dispatch shape rather than calling the handler in isolation.
 */
async function withServer(boundary, run) {
  const server = http.createServer((req, res) => {
    if (boundary && req.url === boundary.path) {
      boundary.handle(req, readJsonBody).then((descriptor) => {
        res.writeHead(descriptor.statusCode, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(descriptor.body));
      }).catch(() => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unexpected' }));
      });
      return;
    }
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

function request(port, { method = 'POST', body, contentType = 'application/json', rawBody } = {}) {
  const payload = rawBody !== undefined ? rawBody : (body === undefined ? '' : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const headers = {};
    if (contentType) headers['Content-Type'] = contentType;
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/a2a/exchange', method, headers,
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
    if (payload) req.write(payload);
    req.end();
  });
}

function freshBoundary(fixtureOptions = {}) {
  const { root, replayDirectory } = makeSandbox();
  // P0-B serves the canonical workspace only, so the route fixture is built
  // in `default`. The conformance suite keeps its own workspace by default,
  // which is why the generator takes it as a parameter rather than a constant.
  const fixture = buildFixture(CANONICAL_WORKSPACE, fixtureOptions);
  const authorityFile = writeAuthority(root, fixture.authority);
  const boundary = createA2aExchangeBoundary({ authorityFile, replayDirectory });
  return { boundary, fixture, root, replayDirectory, authorityFile };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('a2a route: a valid exchange is admitted through the real HTTP boundary', async () => {
  const { boundary, fixture } = freshBoundary();
  assert.ok(boundary, 'boundary must exist when authority and replay dir are configured');

  const response = await withServer(boundary, (port) => request(port, { body: fixture.request }));

  assert.equal(response.status, 200);
  assert.equal(response.body.decision, 'allow');
  assert.equal(response.body.reason, 'ok');
  assert.equal(response.body.effect.admitted, true);
  assert.equal(response.body.effect.exchangeId, fixture.request.exchangeId);
  assert.equal(response.body.effect.receiptMetadata.decision, 'allow');
  assert.equal(response.body.effect.receiptMetadata.firewallVersion, 'AAFW-v1.0.0');
  assert.equal(response.body.effect.receiptMetadata.policy.policyVersion, 'v5-d6-1');
  assert.deepEqual(response.body.effect.receiptMetadata.task, fixture.request.requestedAction);
  assert.equal(
    response.body.effect.receiptMetadata.routeReceipt.parent_receipt_id,
    fixture.request.evidence.receipt.publicReceiptId,
  );
  assert.equal(response.body.effect.receiptMetadata.crossAgentAggregation.status, 'consistent');
  assert.equal(response.body.effect.receiptMetadata.crossAgentAggregation.signal, null);
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('a2a route: replaying the identical exchange is refused by the existing owner', async () => {
  const { boundary, fixture } = freshBoundary();

  const results = await withServer(boundary, async (port) => [
    await request(port, { body: fixture.request }),
    await request(port, { body: fixture.request }),
  ]);

  assert.equal(results[0].status, 200);
  assert.equal(results[0].body.decision, 'allow');
  assert.equal(results[1].status, 403);
  assert.equal(results[1].body.decision, 'block');
  assert.equal(results[1].body.reason, 'replay_detected');
});

test('a2a route: AB5 review stops before effect and replay reservation', async () => {
  // `axiom.trace` is delegation-allowed but is not one of AB5's recognized
  // read-only execution tools, so the signed task reaches a review decision.
  const { boundary, fixture } = freshBoundary({ tool: 'axiom.trace' });

  const results = await withServer(boundary, async (port) => [
    await request(port, { body: fixture.request }),
    await request(port, { body: fixture.request }),
  ]);

  for (const response of results) {
    assert.equal(response.status, 403);
    assert.equal(response.body.decision, 'review');
    assert.equal(response.body.reason, 'UNKNOWN_OPERATION_REVIEW_REQUIRED');
    assert.equal(response.body.safeToRetry, true);
    assert.equal(response.body.receiptMetadata.decision, 'review');
    assert.equal(
      response.body.receiptMetadata.crossAgentAggregation.signal,
      'cross_agent_decision_contradiction',
    );
    assert.equal(response.body.receiptMetadata.crossAgentAggregation.aggregate_risk_score, 50);
    assert.equal(response.body.effect, undefined);
    assert.equal(response.body.taskId, undefined);
  }
});

test('a2a route: a tampered exchange signature is refused with the evaluator reason', async () => {
  const { boundary, fixture } = freshBoundary();
  const tampered = clone(fixture.request);
  // Tamper the signature value, not its shape: a malformed envelope would be
  // refused earlier and would prove nothing about signature verification.
  tampered.signature.value = `${'a'.repeat(8)}${String(tampered.signature.value).slice(8)}`;

  const response = await withServer(boundary, (port) => request(port, { body: tampered }));

  assert.equal(response.status, 403);
  assert.equal(response.body.decision, 'block');
  assert.equal(response.body.reason, 'exchange_signature_invalid');
});

test('a2a route: an escalated delegation scope is refused at the route boundary', async () => {
  const { boundary, fixture } = freshBoundary();
  const escalated = clone(fixture.request);
  escalated.delegation.hops.at(-1).scope.push('capability.escalated');

  const response = await withServer(boundary, (port) => request(port, { body: escalated }));

  assert.equal(response.status, 403);
  assert.equal(response.body.decision, 'block');
  assert.notEqual(response.body.reason, 'ok');
});

test('a2a route: the request body cannot supply its own evaluation clock', async () => {
  const { boundary, fixture } = freshBoundary();
  // An expired exchange stays expired no matter what the payload claims: the
  // evaluator reads the clock from the receiver authority, and the request has
  // no key that could carry one.
  const expired = clone(fixture.request);
  expired.expiresAt = '2020-01-01T00:00:00.000Z';
  expired.evaluationTime = '2020-01-01T00:00:00.000Z';

  const response = await withServer(boundary, (port) => request(port, { body: expired }));

  assert.equal(response.status, 403);
  assert.equal(response.body.decision, 'block');
  assert.notEqual(response.body.reason, 'ok');
});

test('a2a route: only POST is served', async () => {
  const { boundary } = freshBoundary();

  const response = await withServer(boundary, (port) => request(port, { method: 'GET', body: undefined }));

  assert.equal(response.status, 405);
  assert.equal(response.body.reason, A2A_ROUTE_ERRORS.METHOD);
});

test('a2a route: a non-JSON content type is refused as a decision, not a raw guard error', async () => {
  const { boundary, fixture } = freshBoundary();

  const response = await withServer(boundary, (port) => request(port, {
    contentType: 'text/plain',
    rawBody: JSON.stringify(fixture.request),
  }));

  assert.equal(response.status, 415);
  assert.equal(response.body.decision, 'block');
  assert.equal(response.body.reason, A2A_ROUTE_ERRORS.BODY);
});

test('a2a route: malformed JSON is refused', async () => {
  const { boundary } = freshBoundary();

  const response = await withServer(boundary, (port) => request(port, { rawBody: '{"not":' }));

  assert.equal(response.status, 400);
  assert.equal(response.body.decision, 'block');
  assert.equal(response.body.reason, A2A_ROUTE_ERRORS.BODY);
});

test('a2a route: a non-canonical workspace is refused before any verification', async () => {
  const { boundary, fixture } = freshBoundary();
  const other = clone(fixture.request);
  other.workspaceId = 'tenant-b';

  const response = await withServer(boundary, (port) => request(port, { body: other }));

  assert.equal(response.status, 400);
  assert.equal(response.body.decision, 'block');
  assert.equal(response.body.reason, A2A_ROUTE_ERRORS.WORKSPACE);
});

test('a2a route: C3 trust-evidence records are not exchange envelopes and are refused', async () => {
  // These fixtures describe `v5-a2a-trust-evidence-v1`, a different artifact
  // from the `v5-d6-a2a-exchange-v1` envelope this route evaluates. The
  // assertion worth making is therefore that the route refuses the wrong
  // artifact type -- not that it exercises scope or expiry rules, which it
  // never reaches for these inputs.
  const dir = path.join(__dirname, 'fixtures', 'v5', 'a2a-trust-evidence');
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  assert.ok(files.length >= 8, 'the C3 fixture set must still be present');

  const { boundary } = freshBoundary();
  const responses = await withServer(boundary, async (port) => {
    const out = [];
    for (const name of files) {
      const record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      out.push([name, await request(port, { body: record })]);
    }
    return out;
  });

  for (const [name, response] of responses) {
    assert.equal(response.status, 403, `${name} must be refused`);
    assert.equal(response.body.decision, 'block', `${name} must be refused`);
    assert.equal(response.body.reason, 'exchange_shape_invalid', `${name} must be refused as a shape error`);
  }
});

test('a2a route: an unconfigured deployment has no boundary at all', () => {
  assert.equal(createA2aExchangeBoundary({}), null);
  assert.equal(createA2aExchangeBoundary({ authorityFile: '/nonexistent/authority.json', replayDirectory: os.tmpdir() }), null);

  const { replayDirectory } = makeSandbox();
  assert.equal(createA2aExchangeBoundary({ authorityFile: '', replayDirectory }), null);
});

test('a2a route: a relative or symlinked authority path is refused', () => {
  const { root, replayDirectory } = makeSandbox();
  const fixture = buildFixture(CANONICAL_WORKSPACE);
  const real = writeAuthority(root, fixture.authority);

  assert.equal(createA2aExchangeBoundary({ authorityFile: 'authority.json', replayDirectory }), null);

  const link = path.join(root, 'authority-link.json');
  fs.symlinkSync(real, link);
  assert.equal(createA2aExchangeBoundary({ authorityFile: link, replayDirectory }), null);
});

test('a2a route: the auth policy declares the route only when it is configured', () => {
  const enabled = resolveRouteAuthPolicy('/api/a2a/exchange', 'POST', { a2aRouteEnabled: true });
  assert.equal(enabled.known, true);
  assert.equal(enabled.authRequired, true);
  assert.equal(enabled.ruleId, 'a2a-exchange');

  // Unconfigured must stay unknown so the 404 path answers: a 401 here would
  // confirm the surface exists to an unauthenticated caller.
  const disabled = resolveRouteAuthPolicy('/api/a2a/exchange', 'POST', { a2aRouteEnabled: false });
  assert.equal(disabled.known, false);
  assert.equal(disabled.authRequired, false);

  const absent = resolveRouteAuthPolicy('/api/a2a/exchange', 'POST', {});
  assert.equal(absent.known, false);
});

test('a2a route: the production call chain reaches the V5 verification modules', () => {
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(serverSource.includes("require('./lib/http/optional-boundaries')"),
    'server.js must require the optional-route boundary');
  assert.ok(serverSource.includes('optionalRoutes.route(req, res, reqUrl)'),
    'server.js must dispatch to the optional-route boundary');
  // P0-D moved the individual flags into one spreadable authContext so that
  // adding a route stops editing server.js. The enablement still has to reach
  // the auth policy, so the assertion follows it to its new owner rather than
  // being dropped.
  assert.ok(serverSource.includes('...optionalRoutes.authContext'),
    'server.js must pass the enablement context to the auth policy');

  // A second composite now sits above the A2A one: the memory-approval route
  // was the first deployment-gated route that is not A2A, and server.js may not
  // grow a line per route family any more than it could grow one per route.
  // Same rule as the hop below -- assert it rather than assume it, or a
  // composite that stopped requiring the A2A boundary would leave the V5
  // modules unreached with every other assertion here still passing.
  const optionalSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'http', 'optional-boundaries.js'), 'utf8');
  assert.ok(optionalSource.includes("require('../a2a/routes')"),
    'the optional-route boundary must require the A2A boundary');
  assert.ok(optionalSource.includes('a2a.route(req, res, reqUrl)'),
    'the optional-route boundary must dispatch to the A2A boundary');
  assert.ok(optionalSource.includes('...a2a.authContext'),
    'the optional-route boundary must republish the A2A enablement context');

  // P0-C composed the A2A surface behind one mount point so server.js stops
  // growing a line per route. That inserted a hop into this chain, so the hop
  // is asserted rather than assumed: the composite is what makes the exchange
  // reachable now, and a composite that stopped requiring the route would leave
  // the V5 modules unreached with every other assertion here still passing.
  const boundarySource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a2a', 'routes.js'), 'utf8');
  assert.ok(boundarySource.includes('a2aRouteEnabled'),
    'the A2A boundary must publish the exchange route-enabled flag');
  assert.ok(boundarySource.includes("require('./exchange-route')"),
    'the A2A boundary must require the exchange route');
  assert.ok(boundarySource.includes('exchange.route(req, res, reqUrl)'),
    'the A2A boundary must dispatch to the exchange boundary');

  const routeSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a2a', 'exchange-route.js'), 'utf8');
  assert.ok(routeSource.includes("require('./bounded-exchange')"),
    'the route must call the relocated evaluator');

  const evaluatorSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a2a', 'bounded-exchange.js'), 'utf8');
  for (const dependency of [
    '../receipt/cryptographic-profile-contract',
    '../receipt/cryptographic-verification-adapter',
    '../receipt/public-trust-receipt',
    '../receipt/trusted-key-resolver',
  ]) {
    assert.ok(evaluatorSource.includes(`require('${dependency}')`),
      `the evaluator must reach ${dependency}`);
  }
});
