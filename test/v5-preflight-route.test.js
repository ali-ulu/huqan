const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  createV5PreflightRoute,
  READER_PATH,
  STRUCTURAL_SIGNING_PATH,
} = require('../lib/http/v5-preflight-route');

function makeRequest({ method = 'POST', body = null } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = {};
  process.nextTick(() => {
    if (body !== null) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function makeResponse() {
  const res = new EventEmitter();
  res.statusCode = null;
  res.headers = null;
  res.body = null;
  res.writeHead = (statusCode, headers) => {
    res.statusCode = statusCode;
    res.headers = headers;
  };
  res.end = (data) => {
    res.body = data ? JSON.parse(String(data)) : null;
  };
  return res;
}

function parseJsonRequest(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (!chunks.length) {
        resolve(null);
        return;
      }
      resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    });
  });
}

function validReaderCandidate() {
  return {
    schemaVersion: 'v5.shared_trust_package.writer_input.v1',
    packageId: 'preflight-reader-001',
    issuer: { agentId: 'agent-preflight', workspaceId: 'workspace-preflight' },
    subject: { type: 'agent_action', id: 'action-preflight-001' },
    verdict: { status: 'review', reason: 'preflight_test' },
    nonClaims: ['read_only', 'not_trusted', 'not_authorized', 'not_verified'],
  };
}

function validStructuralCandidate() {
  return {
    fixtureType: 'valid',
    caseId: 'preflight-structural-001',
    description: 'structural preflight test',
    signingInput: {
      schemaVersion: 'v5.shared_trust_package.writer_input.v1',
      packageId: 'preflight-structural-001',
      payload: {
        canonicalization: 'json-stable-v1',
        contentRef: 'content:preflight-structural-001',
      },
      keyId: 'key-preflight-001',
      algorithm: 'test-structural-v1',
      signature: 'STRUCTURAL_PLACEHOLDER_NOT_CRYPTOGRAPHIC',
    },
    expected: { status: 'structural_only' },
    nonClaims: ['structural_only', 'not_cryptographic', 'not_trusted'],
  };
}

test('preflight route ignores paths it does not own', async () => {
  const handler = createV5PreflightRoute({ parseJsonRequest });
  const req = makeRequest();
  const res = makeResponse();
  const handled = await handler(req, res, new URL('http://x/api/v5/other'));
  assert.equal(handled, false);
  assert.equal(res.statusCode, null);
});

test('preflight route requires POST for both operations', async () => {
  const handler = createV5PreflightRoute({ parseJsonRequest });
  for (const pathname of [READER_PATH, STRUCTURAL_SIGNING_PATH]) {
    const req = makeRequest({ method: 'GET' });
    const res = makeResponse();
    const handled = await handler(req, res, new URL(`http://x${pathname}`));
    assert.equal(handled, true);
    assert.equal(res.statusCode, 405);
    assert.equal(res.body.error.code, 'METHOD_NOT_ALLOWED');
  }
});

test('reader preflight returns readable without trust or authorization claims', async () => {
  const handler = createV5PreflightRoute({ parseJsonRequest });
  const req = makeRequest({ body: validReaderCandidate() });
  const res = makeResponse();
  const handled = await handler(req, res, new URL(`http://x${READER_PATH}`));
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.status, 'readable');
  assert.equal(res.body.applied, false);
  assert.equal(res.body.nonClaims.includes('readable_does_not_prove_trust'), true);
  assert.equal(Object.hasOwn(res.body, 'trusted'), false);
  assert.equal(Object.hasOwn(res.body, 'authorized'), false);
  assert.equal(Object.hasOwn(res.body, 'verified'), false);
});

test('reader preflight rejects unsupported claims fail closed', async () => {
  const handler = createV5PreflightRoute({ parseJsonRequest });
  const req = makeRequest({ body: { ...validReaderCandidate(), claims: { runtimeReaderImplemented: true } } });
  const res = makeResponse();
  await handler(req, res, new URL(`http://x${READER_PATH}`));
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.reasonCategory, 'runtime_reader_claim');
  assert.equal(res.body.applied, false);
});

test('structural signing preflight returns structural_only and never a cryptographic claim', async () => {
  const handler = createV5PreflightRoute({ parseJsonRequest });
  const req = makeRequest({ body: validStructuralCandidate() });
  const res = makeResponse();
  await handler(req, res, new URL(`http://x${STRUCTURAL_SIGNING_PATH}`));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.status, 'structural_only');
  assert.equal(res.body.applied, false);
  assert.equal(res.body.nonClaims.includes('structural_only_is_not_cryptographic_signing'), true);
  assert.equal(res.body.signingMetadata.signature, 'STRUCTURAL_PLACEHOLDER_NOT_CRYPTOGRAPHIC');
});

test('structural signing preflight rejects prohibited claims', async () => {
  const handler = createV5PreflightRoute({ parseJsonRequest });
  const req = makeRequest({
    body: {
      ...validStructuralCandidate(),
      claims: { signed: true },
    },
  });
  const res = makeResponse();
  await handler(req, res, new URL(`http://x${STRUCTURAL_SIGNING_PATH}`));
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.reasonCategory, 'signature_claim_without_data');
  assert.equal(res.body.applied, false);
});
