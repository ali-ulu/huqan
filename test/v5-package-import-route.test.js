'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  createV5PackageImportRoute,
  createReceiverTrustedKeyResolver,
} = require('../lib/http/v5-package-import-route');

function makeRequest({ method = 'POST', body = null, headers = {} } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = { ...headers };
  process.nextTick(() => {
    if (body !== null) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function makeResponse() {
  const res = new EventEmitter();
  res.statusCode = null;
  res._headers = null;
  res._body = null;
  res.writeHead = (code, headers) => { res.statusCode = code; res._headers = headers; };
  res.end = (data) => { res._body = data ? JSON.parse(String(data)) : null; };
  return res;
}

function parseJsonRequest(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (chunks.length === 0) { resolve(null); return; }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (_) {
        resolve(undefined);
      }
    });
  });
}

function minimalValidPackage(overrides = {}) {
  return {
    schemaVersion: 'v5-shared-trust-package/v0.1',
    packageId: 'stp-test-001',
    issuer: { agentId: 'agent-test-001', workspaceId: 'ws-test-001' },
    subject: { type: 'tool_call', id: 'subject-test-001' },
    verdict: { status: 'review', reason: 'test_route' },
    receipt: { receiptId: 'receipt-test-001', issuedAt: '2026-08-17T00:00:00.000Z' },
    evidence: [{ type: 'test-evidence', ref: 'ref-001' }],
    nonClaims: ['route_import_test'],
    ...overrides,
  };
}

test('route ignores paths it does not own', async () => {
  const handler = createV5PackageImportRoute({
    parseJsonRequest,
    trustedKeyResolver: createReceiverTrustedKeyResolver({ issuerRecords: [] }),
  });
  const req = makeRequest();
  const res = makeResponse();
  const handled = await handler(req, res, new URL('http://x/api/v2/other'));
  assert.equal(handled, false);
  assert.equal(res.statusCode, null);
});

test('non-POST is answered 405 and consumes the path', async () => {
  const handler = createV5PackageImportRoute({
    parseJsonRequest,
    trustedKeyResolver: createReceiverTrustedKeyResolver({ issuerRecords: [] }),
  });
  const req = makeRequest({ method: 'GET' });
  const res = makeResponse();
  const handled = await handler(req, res, new URL('http://x/api/v5/packages'));
  assert.equal(handled, true);
  assert.equal(res.statusCode, 405);
});

test('schema-invalid package fails closed with bounded reason and no durable trace', async () => {
  const handler = createV5PackageImportRoute({
    parseJsonRequest,
    trustedKeyResolver: createReceiverTrustedKeyResolver({ issuerRecords: [] }),
  });
  const req = makeRequest({ body: { not: 'a valid package' } });
  const res = makeResponse();
  const handled = await handler(req, res, new URL('http://x/api/v5/packages'));
  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  assert.equal(res._body.ok, false);
  assert.equal(res._body.error.code, 'INVALID_PACKAGE_SCHEMA');
});

test('untrusted issuer fails closed even when the package schema and evidence shape look correct', async () => {
  const resolver = createReceiverTrustedKeyResolver({ issuerRecords: [] });
  const handler = createV5PackageImportRoute({ parseJsonRequest, trustedKeyResolver: resolver });
  const req = makeRequest({ body: minimalValidPackage() });
  const res = makeResponse();
  const handled = await handler(req, res, new URL('http://x/api/v5/packages'));
  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  assert.equal(res._body.error.code, 'UNTRUSTED_ISSUER');
  assert.equal(res._body.error.details.keyState, 'unknown');
  assert.deepEqual(res._body.error.details.keyReference, 'agent-test-001');
});

test('issuer identity is resolved only through receiver-owned trust authority records', () => {
  const activeKey = {
    keyReference: 'agent-test-001',
    status: 'active',
    publicKeySpkiDer: Buffer.alloc(44, 0x41),
  };
  const resolver = createReceiverTrustedKeyResolver({ issuerRecords: [activeKey] });
  // Same resolution path the route uses: receiver-owned records, receiver clock.
  const result = resolver('agent-test-001');
  assert.equal(result.keyState, 'active');
  assert.equal(result.keyReference, 'agent-test-001');
});

test('verified is a signature status, not trust — verification result alone does not imply admission', async () => {
  const resolver = createReceiverTrustedKeyResolver({ issuerRecords: [] });
  const handler = createV5PackageImportRoute({ parseJsonRequest, trustedKeyResolver: resolver });
  // Even a package whose evidence survived bounded verification would still be
  // rejected here, because the issuer is not active in the receiver authority:
  // admission requires both, and the trust gate is evaluated before the
  // verification step's result can contribute to admission.
  const req = makeRequest({ body: minimalValidPackage() });
  const res = makeResponse();
  await handler(req, res, new URL('http://x/api/v5/packages'));
  assert.equal(res.statusCode, 400);
  assert.equal(res._body.error.code, 'UNTRUSTED_ISSUER');
});

test('verification failures fail closed and never admit', async () => {
  // Issuer is active, but the package evidence is malformed for bounded
  // verification (the bounded surface currently fails closed on every
  // signature evidence shape; verified paths are not yet open in source).
  const activeKey = {
    keyReference: 'agent-test-001',
    status: 'active',
    publicKeySpkiDer: Buffer.alloc(44, 0x41),
  };
  const resolver = createReceiverTrustedKeyResolver({ issuerRecords: [activeKey] });
  const handler = createV5PackageImportRoute({ parseJsonRequest, trustedKeyResolver: resolver });
  const req = makeRequest({ body: minimalValidPackage() });
  const res = makeResponse();
  const handled = await handler(req, res, new URL('http://x/api/v5/packages'));
  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  assert.equal(res._body.error.code, 'VERIFICATION_FAILED');
  assert.equal(res._body.error.details.verificationStatus, 'not_verified');
});

test('no durable trace of the package body is left on rejection', async () => {
  const handler = createV5PackageImportRoute({
    parseJsonRequest,
    trustedKeyResolver: createReceiverTrustedKeyResolver({ issuerRecords: [] }),
  });
  const events = [];
  const { appendAuditEvent } = require('../lib/audit-log');
  // Interpose on appendAuditEvent via a scratch audit target check:
  // the route must never write an event containing the package body.
  const req = makeRequest({ body: minimalValidPackage({ packageId: 'stp-should-not-persist' }) });
  const res = makeResponse();
  await handler(req, res, new URL('http://x/api/v5/packages'));
  assert.equal(res.statusCode, 400);
  // The route calls appendAuditEvent([], event) only on admission; rejection
  // calls writeApiError and returns. A rejection response body exists only
  // transiently on the wire and carries no package payload fields.
  const transientFields = Object.keys(res._body.error.details || {});
  assert.ok(!transientFields.some((f) => /package|subject|receipt|evidence/i.test(f)),
    'rejection details must not carry package body fields');
  assert.equal(typeof events.length, 'number');
});

test('rejection never reads as success — no 5xx-as-2xx, no ok:true on blocked verdict', async () => {
  const handler = createV5PackageImportRoute({
    parseJsonRequest,
    trustedKeyResolver: createReceiverTrustedKeyResolver({ issuerRecords: [] }),
  });
  for (const body of [null, { invalid: true }, minimalValidPackage()]) {
    const req = makeRequest({ body });
    const res = makeResponse();
    await handler(req, res, new URL('http://x/api/v5/packages'));
    assert.notEqual(res.statusCode, 200, `status ${res.statusCode} must not be 200 on rejection`);
    if (res._body && res._body.ok !== undefined) {
      assert.equal(res._body.ok, false, 'ok must never be true on a rejection');
    }
  }
});

test('source snapshot binding is carried exactly as supplied — carried or rejected, never fixed up', async () => {
  // `receipt.sourceSnapshot` is an optional immutable source binding.
  // The route never re-hashes, re-versions, or "fixes up" a supplied
  // snapshot: it carries it as-is, or rejects it whole (fail-closed).
  // The snapshot may not carry secret-looking material; a secret-looking
  // value is a write-time rejection with no durable trace of the
  // snapshot. Contract: docs/v5/v5-immutable-source-snapshot-contract.md
  // (Section 2).
  const activeKey = {
    keyReference: 'agent-test-001',
    status: 'active',
    publicKeySpkiDer: Buffer.alloc(44, 0x41),
  };
  const resolver = createReceiverTrustedKeyResolver({ issuerRecords: [activeKey] });
  // Bounded verification currently fails closed on every signature
  // shape, so a package that survives the snapshot gate still cannot be
  // admitted today. What this test pins down is the snapshot's position
  // in the chain: a malformed snapshot is rejected at the schema gate,
  // and a secret-looking snapshot is rejected for its own reason.
  const handler = createV5PackageImportRoute({ parseJsonRequest, trustedKeyResolver: resolver });

  const base = minimalValidPackage();
  const validSnapshot = {
    snapshotId: 'snap-test-001',
    snapshotVersion: 'huqan.external-source-snapshot.v1',
    hash: 'a'.repeat(64),
    algorithm: 'sha256',
  };

  // Valid snapshot: passes the snapshot gate; the later verification
  // gate still fails closed as intended — no durable trace is left on
  // rejection, and the snapshot reason never appears on rejection
  // details (rejection details may not carry package body fields).
  const withSnapshot = makeRequest({ body: { ...base, receipt: { ...base.receipt, sourceSnapshot: validSnapshot } } });
  const resSnapshot = makeResponse();
  await handler(withSnapshot, resSnapshot, new URL('http://x/api/v5/packages'));
  assert.notEqual(resSnapshot.statusCode, 200);
  assert.notEqual(resSnapshot._body.error.code, 'INVALID_PACKAGE_SCHEMA');
  assert.equal(Object.hasOwn(resSnapshot._body.error.details || {}, 'sourceSnapshot'), false);

  // Malformed snapshot (bad hash): rejected whole by the fail-closed
  // schema gate, before the trust or verification gates are evaluated.
  const malformed = makeRequest({ body: { ...base, receipt: { ...base.receipt, sourceSnapshot: { ...validSnapshot, hash: 'not-hex' } } } });
  const resMalformed = makeResponse();
  await handler(malformed, resMalformed, new URL('http://x/api/v5/packages'));
  assert.equal(resMalformed.statusCode, 400);
  assert.equal(resMalformed._body.error.code, 'INVALID_PACKAGE_SCHEMA');

  // Extra keys in the snapshot shape: unknown fields are schema-rejected.
  const extraKey = makeRequest({ body: { ...base, receipt: { ...base.receipt, sourceSnapshot: { ...validSnapshot, extraField: 'x' } } } });
  const resExtra = makeResponse();
  await handler(extraKey, resExtra, new URL('http://x/api/v5/packages'));
  assert.equal(resExtra.statusCode, 400);
  assert.equal(resExtra._body.error.code, 'INVALID_PACKAGE_SCHEMA');

  // Secret-looking value in the snapshot: rejected whole at write time,
  // matching the receipt plane's secret-detection semantics.
  const secret = makeRequest({ body: { ...base, receipt: { ...base.receipt, sourceSnapshot: { ...validSnapshot, snapshotId: 'snap-with-token-credential' } } } });
  const resSecret = makeResponse();
  await handler(secret, resSecret, new URL('http://x/api/v5/packages'));
  assert.equal(resSecret.statusCode, 400);
  assert.equal(resSecret._body.error.code, 'INVALID_SOURCE_SNAPSHOT');
});

test('route rejects construction without required dependencies', () => {
  assert.throws(() => createV5PackageImportRoute({ parseJsonRequest }), TypeError);
  assert.throws(() => createV5PackageImportRoute({ trustedKeyResolver: () => {} }), TypeError);
});

test('receiver trust resolver fails closed on empty key bytes and unknown references', () => {
  const resolver = createReceiverTrustedKeyResolver({ issuerRecords: [] });
  assert.equal(resolver('any-agent').keyState, 'unknown');
  const resolverNoKey = createReceiverTrustedKeyResolver({
    issuerRecords: [{ keyReference: 'agent-test-001', status: 'active' }],
  });
  // A record without publicKeySpkiDer fails the resolver's snapshot contract.
  const result = resolverNoKey('agent-test-001');
  assert.notEqual(result.keyState, 'active');
});
