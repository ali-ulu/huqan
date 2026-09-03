'use strict';

/**
 * Issue #1787 (Faz F) - the registry admission and read surface, wired.
 *
 * The record shape's own contract is pinned in
 * `test/registry-record-shape.test.js`. What is pinned here is everything that
 * only becomes true once the surface exists: that an unconfigured deployment
 * has no surface at all rather than an unauthorized one, that the route
 * resolves identities through the *same* receiver authority the exchange
 * enforces, that a stored record is durable across boundary restarts, and -
 * the point of the issue - that revoking a key reaches a reader without anyone
 * editing a file.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildFixture } = require('../scripts/a2a-conformance/run.js');
const { resolveRouteAuthPolicy } = require('../lib/http/route-auth-policy');
const { createRegistryBoundary, REGISTRY_COLLECTION_PATH } = require('../lib/registry/registry-route');
const { createRegistryRecordStore, registryRecordId } = require('../lib/registry/registry-record-store');

function tempRoot() {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-1787-')));
}

function writeAuthority(root, authority) {
  const target = path.join(root, 'authority.json');
  fs.writeFileSync(target, JSON.stringify(authority), { mode: 0o600 });
  return target;
}

/** Minimal response double: records what the route decided. */
function responseDouble() {
  const sent = { statusCode: null, body: null, headers: null };
  return {
    sent,
    writeJson: (_req, _res, statusCode, body, headers = {}) => {
      sent.statusCode = statusCode;
      sent.body = body;
      sent.headers = headers;
    },
  };
}

function freshBoundary(mutateAuthority = (authority) => authority) {
  const root = tempRoot();
  const registryDirectory = path.join(root, 'registry');
  fs.mkdirSync(registryDirectory, { mode: 0o700 });

  const fixture = buildFixture('default');
  const authority = mutateAuthority(fixture.authority);
  const authorityFile = writeAuthority(root, authority);
  const replayDirectory = path.join(root, 'replay');
  fs.mkdirSync(replayDirectory, { mode: 0o700 });

  const response = responseDouble();
  let requestBody = null;
  const boundary = createRegistryBoundary({
    authorityFile,
    replayDirectory,
    registryDirectory,
    getParseJsonRequest: () => async () => requestBody,
    getWriteJson: () => response.writeJson,
  });

  return {
    boundary,
    response,
    registryDirectory,
    authorityFile,
    replayDirectory,
    setBody: (body) => { requestBody = body; },
  };
}

function validRegistration() {
  return {
    agentId: 'agent-source',
    identityRef: 'identity:agent-source',
    workspaceId: 'default',
    protocolVersion: '0.2',
    capabilityIds: ['bounded-exchange'],
    trustRootReference: 'test-key:agent-source',
  };
}

async function post(harness, body) {
  harness.setBody(body);
  const handled = await harness.boundary.route(
    { method: 'POST' },
    {},
    { pathname: REGISTRY_COLLECTION_PATH },
  );
  assert.equal(handled, true);
  return harness.response.sent;
}

async function get(harness, recordId) {
  const handled = await harness.boundary.route(
    { method: 'GET' },
    {},
    { pathname: `${REGISTRY_COLLECTION_PATH}/${recordId}` },
  );
  assert.equal(handled, true);
  return harness.response.sent;
}

test('an unconfigured deployment has no registry surface at all', () => {
  const root = tempRoot();
  const fixture = buildFixture('default');
  const authorityFile = writeAuthority(root, fixture.authority);

  // No registry directory: the boundary must refuse to exist rather than serve
  // a route that would always fail.
  assert.equal(createRegistryBoundary({
    authorityFile,
    replayDirectory: root,
    registryDirectory: '',
    getParseJsonRequest: () => async () => null,
    getWriteJson: () => () => {},
  }), null);

  // And the policy turns that into a 404, not a 401: a 401 would confirm the
  // path exists to a caller with no credentials.
  const policy = resolveRouteAuthPolicy(REGISTRY_COLLECTION_PATH, 'POST', { registryRouteEnabled: false });
  assert.equal(policy.known, false);
  assert.equal(policy.authRequired, false);
});

test('a configured registry is authenticated on both its paths', () => {
  for (const [pathname, method] of [
    [REGISTRY_COLLECTION_PATH, 'POST'],
    [`${REGISTRY_COLLECTION_PATH}/${'a'.repeat(64)}`, 'GET'],
  ]) {
    const policy = resolveRouteAuthPolicy(pathname, method, { registryRouteEnabled: true });
    assert.equal(policy.known, true, pathname);
    assert.equal(policy.authRequired, true, pathname);
    assert.equal(policy.ruleId, 'registry-records');
  }
});

test('a symlinked registry directory is refused', () => {
  const root = tempRoot();
  const real = path.join(root, 'real');
  fs.mkdirSync(real);
  const link = path.join(root, 'link');
  try {
    fs.symlinkSync(real, link, 'junction');
  } catch (_) {
    return; // Symlink creation is privileged on some Windows configurations.
  }

  const fixture = buildFixture('default');
  assert.equal(createRegistryBoundary({
    authorityFile: writeAuthority(root, fixture.authority),
    replayDirectory: real,
    registryDirectory: link,
    getParseJsonRequest: () => async () => null,
    getWriteJson: () => () => {},
  }), null);
});

test('registering an identity the receiver holds returns a resolvable record id', async () => {
  const harness = freshBoundary();
  const created = await post(harness, validRegistration());

  assert.equal(created.statusCode, 201);
  assert.equal(created.body.decision, 'admit');
  assert.equal(created.body.record.recordVersion, 1);
  assert.equal(created.body.record.authenticationRequired, true);
  assert.equal(created.headers['Cache-Control'], 'no-store');

  const read = await get(harness, created.body.recordId);
  assert.equal(read.statusCode, 200);
  assert.deepEqual(read.body.record, created.body.record);
});

test('an identity the receiver does not hold is refused', async () => {
  const harness = freshBoundary();
  const sent = await post(harness, { ...validRegistration(), agentId: 'agent-stranger', identityRef: 'identity:stranger' });

  assert.equal(sent.statusCode, 400);
  assert.equal(sent.body.reason, 'identity_not_receiver_held');
});

test('re-registering the same identity bumps the version and keeps one record', async () => {
  const harness = freshBoundary();
  const first = await post(harness, validRegistration());
  const second = await post(harness, validRegistration());

  assert.equal(second.statusCode, 201);
  assert.equal(second.body.recordId, first.body.recordId, 'one identity, one record');
  assert.equal(second.body.record.recordVersion, 2);

  const stored = fs.readdirSync(harness.registryDirectory).filter((name) => name.endsWith('.json'));
  assert.equal(stored.length, 1, 'a re-registration must not create a second row');
});

test('a record survives a boundary restart, because the store is on disk', async () => {
  const harness = freshBoundary();
  const created = await post(harness, validRegistration());

  const store = createRegistryRecordStore(harness.registryDirectory);
  const reread = store.read(created.body.recordId);
  assert.equal(reread.identityRef, 'identity:agent-source');
  assert.equal(reread.recordVersion, 1);
});

test('revoking a key excludes an already-admitted record at read time', async () => {
  // The whole point of #1787: revocation must reach a reader without anyone
  // hand-editing the reader's copy. The record is admitted while the key is
  // active, then the authority revokes it and the *same stored record* stops
  // resolving.
  const admitted = freshBoundary();
  const created = await post(admitted, validRegistration());
  assert.equal(created.statusCode, 201);

  const revoked = freshBoundary((authority) => ({
    ...authority,
    keys: authority.keys.map((entry) => (entry.keyReference === 'test-key:agent-source'
      ? { ...entry, status: 'revoked' }
      : entry)),
  }));
  // Move the already-stored record into the revoked deployment's store, so the
  // record is identical and only the authority differs.
  fs.copyFileSync(
    path.join(admitted.registryDirectory, `${created.body.recordId}.json`),
    path.join(revoked.registryDirectory, `${created.body.recordId}.json`),
  );

  const read = await get(revoked, created.body.recordId);
  assert.equal(read.statusCode, 409);
  assert.equal(read.body.reason, 'trust_root_not_active');
  assert.equal(read.body.resolvedKeyState, 'revoked');
  assert.equal(Object.hasOwn(read.body, 'record'), false, 'no stale admitted copy');
});

test('an unknown record id and a malformed one are answered identically', async () => {
  const harness = freshBoundary();

  const unknown = await get(harness, 'b'.repeat(64));
  const malformed = await get(harness, 'not-a-record-id');

  assert.equal(unknown.statusCode, 404);
  assert.deepEqual(malformed, unknown, 'the difference would be a probe');
});

test('a non-POST registration and a non-GET read are refused', async () => {
  const harness = freshBoundary();

  const badCollection = await harness.boundary.route({ method: 'GET' }, {}, { pathname: REGISTRY_COLLECTION_PATH });
  assert.equal(badCollection, true);
  assert.equal(harness.response.sent.statusCode, 405);

  const badItem = await harness.boundary.route({ method: 'DELETE' }, {}, { pathname: `${REGISTRY_COLLECTION_PATH}/${'c'.repeat(64)}` });
  assert.equal(badItem, true);
  assert.equal(harness.response.sent.statusCode, 405);
});

test('the boundary does not claim paths outside its own surface', async () => {
  const harness = freshBoundary();
  const handled = await harness.boundary.route({ method: 'POST' }, {}, { pathname: '/api/a2a/exchange' });
  assert.equal(handled, false);
});

test('record ids are domain-separated so two identities cannot collide', () => {
  // Without length-prefixing, workspace "a" + ref "bc" and workspace "ab" +
  // ref "c" would hash the same input and one identity would overwrite the
  // other's row.
  assert.notEqual(
    registryRecordId({ workspaceId: 'a', identityRef: 'bc' }),
    registryRecordId({ workspaceId: 'ab', identityRef: 'c' }),
  );
});

test('a stored file whose contents name another identity is not served', async () => {
  const harness = freshBoundary();
  const created = await post(harness, validRegistration());

  const target = path.join(harness.registryDirectory, `${created.body.recordId}.json`);
  const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
  parsed.record.identityRef = 'identity:agent-target';
  fs.writeFileSync(target, JSON.stringify(parsed));

  const read = await get(harness, created.body.recordId);
  assert.equal(read.statusCode, 404, 'a filename/content mismatch is refused, not resolved');
});
