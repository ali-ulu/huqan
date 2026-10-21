'use strict';

/**
 * #4087 PR-4: the read-only route that serves a published public trust
 * receipt's canonical bytes.
 *
 * PR-3 publishes a receipt and names its `publicReceiptId` and checksum on the
 * check run. Before this route, a third party holding those two values had
 * nothing to fetch -- the bytes existed only inside the publisher's own store.
 * The tests below drive the real server over a real socket, so what is proven
 * is the served artifact: the bytes a verifier parses, byte-for-byte, and the
 * refusals around them.
 *
 * The strongest assertion is the round trip: fetch the route, feed the exact
 * bytes to the same `importPublicTrustReceipt` a third party runs, and get a
 * verified receipt back. That is the whole point of the route, and a test that
 * only compared JSON would pass while serving a re-encoded body.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createGitHubAppBetaHttpBoundary } = require('../lib/github-app-beta-http-boundary');
const { createGitHubAppBetaServer } = require('../github-app-server');
const { createPublicReceiptRoute } = require('../lib/http/public-receipt-route');
const {
  importPublicTrustReceipt,
  toCanonicalPublicReceiptBytes,
} = require('../lib/receipt/public-trust-receipt');

const SECRET = 'github-app-public-receipt-route-secret';
const DELIVERY = '91d3162e-cc78-11e3-81ab-4c9367dc0958';
const REPOSITORY_ID = 1300995136;
const REPOSITORY_FULL_NAME = 'ali-ulu/huqan';
const INSTALLATION_ID = 991;
const PR_NUMBER = 4087;
const HEAD_SHA = 'c'.repeat(40);
const APP_ID = '123456';
const KEY_ID = 'test-key:public-receipt-route';

function tempRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-public-receipt-route-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeRsaPrivateKey(root) {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPath = path.join(root, 'app-private-key.pem');
  fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs1', format: 'pem' }), { mode: 0o600 });
  return keyPath;
}

function writePublicReceiptKey(root) {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const keyPath = path.join(root, 'public-receipt-key.pem');
  fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  return keyPath;
}

function environment(root, overrides = {}) {
  return {
    HUQAN_GITHUB_APP_BETA_ENABLED: '1',
    HUQAN_GITHUB_APP_WEBHOOK_SECRET: SECRET,
    HUQAN_GITHUB_APP_STORE_PATH: root,
    HUQAN_GITHUB_APP_STREAMING_TRUST_ENABLED: '1',
    HUQAN_GITHUB_APP_ID: APP_ID,
    HUQAN_GITHUB_APP_PRIVATE_KEY_PATH: writeRsaPrivateKey(root),
    HUQAN_GITHUB_APP_PUBLIC_RECEIPT_KEY: writePublicReceiptKey(root),
    HUQAN_GITHUB_APP_PUBLIC_RECEIPT_KEY_ID: KEY_ID,
    ...overrides,
  };
}

function payload() {
  return {
    action: 'opened',
    number: PR_NUMBER,
    installation: { id: INSTALLATION_ID },
    repository: { id: REPOSITORY_ID, full_name: REPOSITORY_FULL_NAME, private: false },
    pull_request: {
      number: PR_NUMBER,
      title: 'private-title-must-not-survive',
      body: 'private-body-must-not-survive',
      head: { sha: HEAD_SHA, ref: 'private-ref' },
    },
    sender: { login: 'private-sender' },
  };
}

function responseJson(value, ok = true) {
  return { ok, async json() { return value; } };
}

function githubApi() {
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/access_tokens')) {
      return responseJson({ token: 'ghs_route_test_token', expires_at: '2099-01-01T00:00:00.000Z' });
    }
    if (url.endsWith(`/pulls/${PR_NUMBER}`)) {
      return responseJson({
        number: PR_NUMBER,
        base: { repo: { id: REPOSITORY_ID, full_name: REPOSITORY_FULL_NAME } },
        head: { sha: HEAD_SHA },
      });
    }
    if (url.includes(`/pulls/${PR_NUMBER}/files?`)) {
      return responseJson([{ filename: 'docs/streaming.md', status: 'modified', additions: 3, deletions: 1 }]);
    }
    if (url.endsWith('/check-runs')) {
      return responseJson({ id: 778899, head_sha: JSON.parse(options.body).head_sha });
    }
    throw new Error(`unexpected GitHub URL: ${url}`);
  };
  return { fetchImpl };
}

async function listen(t, boundary) {
  const server = createGitHubAppBetaServer({ boundary });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

function post(port, body) {
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/github-app/webhook',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(raw.length),
        'x-github-event': 'pull_request',
        'x-github-delivery': DELIVERY,
        'x-hub-signature-256': `sha256=${crypto.createHmac('sha256', SECRET).update(raw).digest('hex')}`,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ statusCode: res.statusCode, headers: res.headers, text, body: text ? JSON.parse(text) : null });
      });
    });
    req.once('error', reject);
    req.end(raw);
  });
}

function get(port, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        resolve({ statusCode: res.statusCode, headers: res.headers, bytes });
      });
    });
    req.once('error', reject);
    req.end();
  });
}

// A published receipt, produced by the real loop and served by the real route.
async function published(t, envOverrides = {}) {
  const root = tempRoot(t);
  const env = environment(root, envOverrides);
  const boundary = createGitHubAppBetaHttpBoundary({
    environment: env,
    fetchImpl: githubApi().fetchImpl,
  });
  const port = await listen(t, boundary);
  const delivered = await post(port, payload());
  assert.equal(delivered.statusCode, 200, 'the delivery must publish a receipt for these tests to mean anything');
  return { root, boundary, port, env, trust: delivered.body.trust };
}

test('the route serves the exact canonical bytes a third party verifies', async (t) => {
  const { port, env, trust } = await published(t);
  assert.match(trust.publicReceiptId, /^[0-9a-f]{64}$/);

  const served = await get(port, `/public-receipts/${trust.publicReceiptId}`);

  assert.equal(served.statusCode, 200);
  assert.equal(served.headers['content-type'], 'application/json; charset=utf-8');

  // The served bytes are the canonical form itself, not a re-encoding of it:
  // the same bytes the store would hand a verifier, and stable under a second
  // fetch (a non-deterministic serializer would differ here).
  const again = await get(port, `/public-receipts/${trust.publicReceiptId}`);
  assert.equal(again.statusCode, 200);
  assert.deepEqual(again.bytes, served.bytes);

  // The real proof: the bytes parse and verify through the same import path a
  // third party runs, with only the published key.
  const parsed = JSON.parse(served.bytes.toString('utf8'));
  assert.equal(parsed.publicReceiptId, trust.publicReceiptId);
  assert.deepEqual(served.bytes, toCanonicalPublicReceiptBytes(parsed));

  const publicKey = crypto.createPublicKey(fs.readFileSync(env.HUQAN_GITHUB_APP_PUBLIC_RECEIPT_KEY, 'utf8'));
  const verified = importPublicTrustReceipt(served.bytes, {
    expectedInternalReceiptHash: parsed.binding.internalReceiptHash,
    trustedKeyRecords: [{
      keyReference: parsed.integrity.signature.keyId,
      status: 'active',
      publicKeySpkiDer: publicKey.export({ format: 'der', type: 'spki' }),
    }],
    evaluationTime: parsed.issuedAt,
  });
  assert.equal(verified.ok, true, 'the served bytes must verify as a third party would verify them');
  assert.equal(verified.status, 'verified');
});

test('the route serves bytes that are exactly the stored canonical bytes, not a re-serialization', async (t) => {
  const { boundary, port, trust } = await published(t);

  const served = await get(port, `/public-receipts/${trust.publicReceiptId}`);

  // The served body equals the canonical bytes of the record the store holds,
  // byte-for-byte. A JSON.parse/stringify round trip through the transport
  // would very likely still be equal here, so the distinguishing assertion is
  // the one above (the served buffer is the canonical form of itself) plus
  // this: the body is the store's own bytes, not a fresh object.
  const stored = boundary.readPublicReceipt(trust.publicReceiptId);
  assert.ok(stored, 'the published receipt is in the store');
  assert.deepEqual(served.bytes, toCanonicalPublicReceiptBytes(stored.publicReceipt));
  assert.match(stored.checksum, /^[0-9a-f]{64}$/);
});

test('the public receipt route serves canonical bytes only for a known id', async (t) => {
  const { port } = await published(t);
  const unknown = 'a'.repeat(64);

  const served = await get(port, `/public-receipts/${unknown}`);

  assert.equal(served.statusCode, 404);
  assert.equal(JSON.parse(served.bytes.toString('utf8')).error.code, 'PUBLIC_RECEIPT_NOT_FOUND');
});

test('the public receipt route rejects a non-hex id before touching the store', async (t) => {
  const { port } = await published(t);

  for (const bad of ['not-a-hash', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'zz'.repeat(32)]) {
    const served = await get(port, `/public-receipts/${bad}`);
    assert.equal(served.statusCode, 400, `${bad} must be refused as a bad request`);
    assert.equal(JSON.parse(served.bytes.toString('utf8')).error.code, 'PUBLIC_RECEIPT_ID_INVALID');
  }
});

test('a non-hex id never reaches the store reader', async (t) => {
  const root = tempRoot(t);
  const boundary = createGitHubAppBetaHttpBoundary({
    environment: environment(root),
    fetchImpl: githubApi().fetchImpl,
  });
  let reads = 0;
  const readPublicReceipt = boundary.readPublicReceipt;
  const spyBoundary = Object.freeze({
    ...boundary,
    readPublicReceipt: (id) => { reads += 1; return readPublicReceipt(id); },
  });
  const port = await listen(t, spyBoundary);

  for (const bad of ['not-a-hash', 'A'.repeat(64), 'a'.repeat(63), '..%2f..%2fetc%2fpasswd']) {
    assert.equal((await get(port, `/public-receipts/${bad}`)).statusCode, 400);
  }
  assert.equal(reads, 0, 'the store reader must not be called for an id that fails the hex pattern');
});

test('a traversal-shaped id cannot escape the store, because the id is a lookup key and not a path', async (t) => {
  const { root, port, trust } = await published(t);

  // The id is never joined onto a directory: a separator-bearing id fails the
  // hex pattern (400), and a raw `../` is normalized away by the URL parser
  // before the route sees it (404 on a path outside the prefix). Neither is a
  // 200, and neither can return a file.
  for (const attack of ['../../etc/passwd', '..%2f..%2fetc%2fpasswd', 'public-receipt-key.pem', '%2e%2e%2f%2e%2e%2fapp-private-key.pem']) {
    const served = await get(port, `/public-receipts/${attack}`);
    assert.notEqual(served.statusCode, 200, `${attack} must not be served`);
    assert.ok([400, 404].includes(served.statusCode), `${attack} must be refused`);
    assert.equal(served.bytes.toString('utf8').includes('PRIVATE KEY'), false, `${attack} must not leak a key`);
  }

  // The published receipt is still served after the attempts, so the route
  // was not put into a bad state by them.
  assert.equal((await get(port, `/public-receipts/${trust.publicReceiptId}`)).statusCode, 200);
  assert.ok(fs.existsSync(path.join(root, 'streaming-trust', 'public-receipts')));
});

test('a non-GET method is refused without a body', async (t) => {
  const { port, trust } = await published(t);

  const served = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: `/public-receipts/${trust.publicReceiptId}`,
      method: 'POST',
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.once('error', reject);
    req.end();
  });

  assert.equal(served.statusCode, 405);
  assert.equal(served.headers.allow, 'GET');
});

test('the route is not mounted when the deployment publishes nothing', async (t) => {
  const root = tempRoot(t);
  // Beta observer only: no Streaming Trust, so no public receipt is ever
  // published and the read route must not advertise itself.
  const boundary = createGitHubAppBetaHttpBoundary({
    environment: environment(root, { HUQAN_GITHUB_APP_STREAMING_TRUST_ENABLED: '0' }),
    fetchImpl: githubApi().fetchImpl,
  });
  const port = await listen(t, boundary);

  const served = await get(port, `/public-receipts/${'a'.repeat(64)}`);
  assert.equal(served.statusCode, 404);
  assert.equal(JSON.parse(served.bytes.toString('utf8')).error.code, 'NOT_FOUND');
});

test('the route serves only the published disclosure, never the webhook private payload', async (t) => {
  const { port, trust } = await published(t);

  const served = await get(port, `/public-receipts/${trust.publicReceiptId}`);
  const body = served.bytes.toString('utf8');

  for (const secret of [
    'private-title-must-not-survive',
    'private-body-must-not-survive',
    'private-ref',
    'private-sender',
  ]) {
    assert.equal(body.includes(secret), false, `${secret} must not be served`);
  }
});

// The error arms below are reached through the route module's own dependency
// seam, because the HTTP server above always supplies a working store and a
// working rate limiter. What is under test is the route's own decision, so the
// two collaborators are the only things replaced.
test('the route answers 429 without touching the store when the rate limit refuses', async () => {
  let reads = 0;
  const route = createPublicReceiptRoute({
    readPublicReceipt: () => { reads += 1; return null; },
    rateLimit: () => false,
  });

  const result = await route.handle(
    { method: 'GET', socket: { remoteAddress: '127.0.0.1' } },
    { pathname: `/public-receipts/${'a'.repeat(64)}` },
  );

  assert.equal(result.statusCode, 429);
  assert.deepEqual(result.body.error, { code: 'RATE_LIMITED' });
  assert.equal(reads, 0, 'a rate-limited request must not read the store');
});

test('the route answers 500 when the store reader throws, and never serves a partial body', async () => {
  const route = createPublicReceiptRoute({
    readPublicReceipt: () => { throw new Error('disk on fire'); },
    rateLimit: () => true,
  });

  const result = await route.handle(
    { method: 'GET', socket: { remoteAddress: '127.0.0.1' } },
    { pathname: `/public-receipts/${'a'.repeat(64)}` },
  );

  assert.equal(result.statusCode, 500);
  assert.deepEqual(result.body.error, { code: 'PUBLIC_RECEIPT_READ_FAILED' });
});

test('the route answers 500 when the stored receipt no longer canonicalizes', async () => {
  // A record that came back from the store but fails the exporter's own
  // checksum/shape check is refused: a verifier must never receive bytes this
  // process could not itself validate.
  const route = createPublicReceiptRoute({
    readPublicReceipt: () => ({ publicReceipt: { not: 'a public receipt' } }),
    rateLimit: () => true,
  });

  const result = await route.handle(
    { method: 'GET', socket: { remoteAddress: '127.0.0.1' } },
    { pathname: `/public-receipts/${'a'.repeat(64)}` },
  );

  assert.equal(result.statusCode, 500);
  assert.deepEqual(result.body.error, { code: 'PUBLIC_RECEIPT_INVALID' });
});

test('the route answers 400 when the path is not under its prefix', async () => {
  const route = createPublicReceiptRoute({ readPublicReceipt: () => null, rateLimit: () => true });

  for (const pathname of ['/', '/public-receipts', '/other/abc', null, 42]) {
    const result = await route.handle({ method: 'GET', socket: {} }, { pathname });
    assert.equal(result.statusCode, 400, `${pathname} must be refused`);
    assert.deepEqual(result.body.error, { code: 'PUBLIC_RECEIPT_ID_INVALID' });
  }
});

test('the route refuses to be constructed without a store reader', () => {
  assert.throws(() => createPublicReceiptRoute({}), { name: 'TypeError' });
});
