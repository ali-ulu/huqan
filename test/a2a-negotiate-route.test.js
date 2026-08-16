'use strict';

/**
 * Contract for capability negotiation and POST /api/a2a/negotiate (P0-D).
 *
 * A negotiator is an attractive thing to attack, because its job is to produce
 * a statement the caller will then rely on. The tests below are organised
 * around the three ways it could be turned into an escalation primitive rather
 * than around its happy path:
 *
 *   - agreeing to something the receiver does not offer;
 *   - letting the caller supply the descriptor it gets back;
 *   - reporting "no agreement" in a way a caller could mistake for success.
 *
 * The offer is asserted against `lib/a2a/agent-card.js`'s own table rather than
 * a copy, so a card and a negotiation that drifted apart fail here.
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
const { CANONICAL_WORKSPACE } = require('../lib/a2a/exchange-route');
const { CAPABILITIES, PROTOCOL_VERSION } = require('../lib/a2a/agent-card');
const {
  NEGOTIATION_ERRORS,
  MAX_LIST_ITEMS,
  MAX_STRING_LENGTH,
  negotiateCapabilities,
} = require('../lib/a2a/capability-negotiation');
const {
  A2A_NEGOTIATE_PATH,
  NEGOTIATE_ROUTE_ERRORS,
  createNegotiateBoundary,
} = require('../lib/a2a/negotiate-route');

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-a2a-negotiate-'));
  const replayDirectory = path.join(root, 'replay');
  fs.mkdirSync(replayDirectory);
  return { root, replayDirectory };
}

function freshBoundary() {
  const { root, replayDirectory } = makeSandbox();
  const file = path.join(root, 'authority.json');
  fs.writeFileSync(file, JSON.stringify(buildFixture(CANONICAL_WORKSPACE).authority), 'utf8');
  return { boundary: createNegotiateBoundary({ authorityFile: file, replayDirectory }), root, replayDirectory };
}

async function withServer(boundary, run) {
  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url, 'http://127.0.0.1');
    boundary.route(req, res, reqUrl).then((handled) => {
      if (handled) return;
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function request(port, { method = 'POST', body } = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    const req = http.request({ host: '127.0.0.1', port, path: A2A_NEGOTIATE_PATH, method, headers }, (res) => {
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

test('negotiation: a common protocol version and capability produce an agreement', async () => {
  const { boundary } = freshBoundary();
  const response = await withServer(boundary, (port) => request(port, {
    body: { protocolVersions: [PROTOCOL_VERSION], capabilities: ['bounded-exchange'] },
  }));

  assert.equal(response.status, 200);
  assert.equal(response.body.decision, 'allow');
  assert.equal(response.body.reason, 'ok');
  assert.equal(response.body.agreement.protocolVersion, PROTOCOL_VERSION);
  assert.deepEqual(response.body.agreement.capabilities.map((entry) => entry.id), ['bounded-exchange']);
  assert.deepEqual(response.body.agreement.declined, []);
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('negotiation: the agreement is a subset of the offer, never a union', () => {
  const result = negotiateCapabilities({
    protocolVersions: [PROTOCOL_VERSION],
    capabilities: ['bounded-exchange', 'streaming-trust', 'task-lifecycle'],
  });

  assert.equal(result.decision, 'allow');
  // Asking for three did not produce three. The two the receiver does not offer
  // come back named, so the caller cannot mistake them for agreed.
  assert.deepEqual(result.agreement.capabilities.map((entry) => entry.id), ['bounded-exchange']);
  assert.deepEqual(result.agreement.declined, ['streaming-trust', 'task-lifecycle']);
});

test('negotiation: the offer is the Agent Card table, not a second copy', () => {
  const result = negotiateCapabilities({
    protocolVersions: [PROTOCOL_VERSION],
    capabilities: CAPABILITIES.map((entry) => entry.id),
  });

  // Identity, not deep equality: a drifted duplicate table would still be
  // deep-equal on the day it was copied and diverge silently afterwards.
  assert.deepEqual(result.agreement.capabilities, CAPABILITIES.filter(() => true));
  for (const agreed of result.agreement.capabilities) {
    assert.ok(CAPABILITIES.includes(agreed), 'every agreed descriptor must be the card\'s own object');
  }
});

test('negotiation: a caller cannot negotiate itself a path or a method', async () => {
  const { boundary } = freshBoundary();
  const response = await withServer(boundary, (port) => request(port, {
    body: {
      protocolVersions: [PROTOCOL_VERSION],
      capabilities: ['bounded-exchange'],
      // All of these are ignored: descriptors come from the frozen table.
      path: '/api/a2a/anything',
      method: 'DELETE',
      agreement: { capabilities: [{ id: 'bounded-exchange', path: '/etc/passwd', method: 'GET' }] },
    },
  }));

  assert.equal(response.status, 200);
  const agreed = response.body.agreement.capabilities[0];
  assert.equal(agreed.path, '/api/a2a/exchange');
  assert.equal(agreed.method, 'POST');
});

test('negotiation: no common protocol version is a refusal, not an empty agreement', async () => {
  const { boundary } = freshBoundary();
  const response = await withServer(boundary, (port) => request(port, {
    body: { protocolVersions: ['0.1', '9.9'], capabilities: ['bounded-exchange'] },
  }));

  // 409, not 403: the caller was allowed to ask. There is simply nothing in
  // common, and reading that as an auth failure would be wrong.
  assert.equal(response.status, 409);
  assert.equal(response.body.decision, 'block');
  assert.equal(response.body.reason, NEGOTIATION_ERRORS.PROTOCOL);
  assert.equal(response.body.agreement, undefined);
});

test('negotiation: no common capability is a refusal, not an empty agreement', async () => {
  const { boundary } = freshBoundary();
  const response = await withServer(boundary, (port) => request(port, {
    body: { protocolVersions: [PROTOCOL_VERSION], capabilities: ['task-lifecycle'] },
  }));

  assert.equal(response.status, 409);
  assert.equal(response.body.decision, 'block');
  assert.equal(response.body.reason, NEGOTIATION_ERRORS.CAPABILITY);
  assert.equal(response.body.agreement, undefined);
});

test('negotiation: receiver preference decides the version, not caller order', () => {
  const result = negotiateCapabilities({
    // A caller listing an unsupported version first must not steer the result.
    protocolVersions: ['9.9', PROTOCOL_VERSION],
    capabilities: ['bounded-exchange'],
  });

  assert.equal(result.decision, 'allow');
  assert.equal(result.agreement.protocolVersion, PROTOCOL_VERSION);
});

test('negotiation: a malformed or unbounded request is refused before any matching', () => {
  const valid = { protocolVersions: [PROTOCOL_VERSION], capabilities: ['bounded-exchange'] };

  for (const [name, body] of [
    ['null', null],
    ['array', []],
    ['missing versions', { capabilities: ['bounded-exchange'] }],
    ['missing capabilities', { protocolVersions: [PROTOCOL_VERSION] }],
    ['empty versions', { ...valid, protocolVersions: [] }],
    ['empty capabilities', { ...valid, capabilities: [] }],
    ['non-string entry', { ...valid, capabilities: [{ id: 'bounded-exchange' }] }],
    ['versions not an array', { ...valid, protocolVersions: PROTOCOL_VERSION }],
    ['oversized list', { ...valid, capabilities: Array.from({ length: MAX_LIST_ITEMS + 1 }, (_, i) => `c${i}`) }],
    ['oversized string', { ...valid, capabilities: ['x'.repeat(MAX_STRING_LENGTH + 1)] }],
  ]) {
    const result = negotiateCapabilities(body);
    assert.equal(result.decision, 'block', `${name} must be refused`);
    assert.equal(result.reason, NEGOTIATION_ERRORS.SHAPE, `${name} must be a shape refusal`);
  }
});

test('negotiation: an empty capability list is refused rather than treated as "send everything"', () => {
  const result = negotiateCapabilities({ protocolVersions: [PROTOCOL_VERSION], capabilities: [] });
  assert.equal(result.decision, 'block');
  assert.equal(result.reason, NEGOTIATION_ERRORS.SHAPE);
});

test('negotiation: a non-canonical workspace is refused before any matching', async () => {
  const { boundary } = freshBoundary();
  const response = await withServer(boundary, (port) => request(port, {
    body: { workspaceId: 'other', protocolVersions: [PROTOCOL_VERSION], capabilities: ['bounded-exchange'] },
  }));

  assert.equal(response.status, 400);
  assert.equal(response.body.reason, NEGOTIATE_ROUTE_ERRORS.WORKSPACE);
});

test('negotiation: only POST is served', async () => {
  const { boundary } = freshBoundary();
  const response = await withServer(boundary, (port) => request(port, { method: 'GET' }));

  assert.equal(response.status, 405);
  assert.equal(response.body.reason, NEGOTIATE_ROUTE_ERRORS.METHOD);
});

test('negotiation: the route is authenticated, and unconfigured stays a 404', () => {
  const enabled = resolveRouteAuthPolicy(A2A_NEGOTIATE_PATH, 'POST', { a2aNegotiateRouteEnabled: true });
  assert.equal(enabled.known, true);
  assert.equal(enabled.authRequired, true);
  assert.equal(enabled.ruleId, 'a2a-negotiate');

  const disabled = resolveRouteAuthPolicy(A2A_NEGOTIATE_PATH, 'POST', {});
  assert.equal(disabled.known, false);
  assert.equal(disabled.authRequired, false);
});

test('negotiation: no boundary without the configuration the agreement depends on', () => {
  assert.equal(createNegotiateBoundary({}), null);

  // The agreement names /api/a2a/exchange, so a deployment that cannot serve
  // that route must not be able to agree to it.
  const { root, replayDirectory } = makeSandbox();
  const file = path.join(root, 'authority.json');
  fs.writeFileSync(file, JSON.stringify(buildFixture(CANONICAL_WORKSPACE).authority), 'utf8');
  assert.equal(createNegotiateBoundary({ authorityFile: file, replayDirectory: '' }), null);
  assert.ok(createNegotiateBoundary({ authorityFile: file, replayDirectory }));
});
