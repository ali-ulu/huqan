'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MAX_WEBHOOK_BYTES,
} = require('../lib/github-app-beta-handler');
const {
  createGitHubAppBetaHttpBoundary,
} = require('../lib/github-app-beta-http-boundary');
const {
  createGitHubAppBetaServer,
} = require('../github-app-server');

const SECRET = 'github-app-beta-http-secret';
const DELIVERY = '72d3162e-cc78-11e3-81ab-4c9367dc0958';

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-github-app-http-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function environment(root, overrides = {}) {
  return {
    HUQAN_GITHUB_APP_BETA_ENABLED: '1',
    HUQAN_GITHUB_APP_WEBHOOK_SECRET: SECRET,
    HUQAN_GITHUB_APP_STORE_PATH: root,
    ...overrides,
  };
}

function pullRequestPayload(action = 'opened') {
  return {
    action,
    number: 279,
    installation: { id: 991 },
    repository: { id: 1300995136, full_name: 'ali-ulu/huqan' },
    pull_request: {
      number: 279,
      title: 'must not be stored',
      body: 'private body must not be stored',
      head: { sha: 'a'.repeat(40), ref: 'private-ref' },
    },
    sender: { login: 'private-sender' },
  };
}

function signature(body) {
  return `sha256=${crypto.createHmac('sha256', SECRET).update(body).digest('hex')}`;
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

function collectResponse(res, resolve) {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8');
    resolve({
      statusCode: res.statusCode,
      headers: res.headers,
      body: text ? JSON.parse(text) : null,
    });
  });
}

function request(port, { pathname = '/api/github-app/webhook', body = Buffer.from('{}'), headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(body.length),
        ...headers,
      },
    }, (res) => collectResponse(res, resolve));
    req.once('error', reject);
    req.end(body);
  });
}

function requestChunked(port, chunks) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/github-app/webhook',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'transfer-encoding': 'chunked',
      },
    }, (res) => collectResponse(res, resolve));
    req.once('error', reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

test('production boundary is absent by default and partial opt-in fails closed', (t) => {
  const root = tempRoot(t);
  assert.equal(createGitHubAppBetaHttpBoundary({ environment: {} }), null);
  assert.throws(
    () => createGitHubAppBetaHttpBoundary({
      environment: { HUQAN_GITHUB_APP_BETA_ENABLED: '1', HUQAN_GITHUB_APP_STORE_PATH: root },
    }),
    (error) => error.code === 'GITHUB_APP_BETA_CONFIG_INVALID',
  );
  assert.throws(
    () => createGitHubAppBetaHttpBoundary({ environment: { HUQAN_GITHUB_APP_BETA_ENABLED: 'true' } }),
    (error) => error.code === 'GITHUB_APP_BETA_CONFIG_INVALID',
  );
});

test('real HTTP PR delivery emits one canonical receipt and redelivery is idempotent', async (t) => {
  const root = tempRoot(t);
  const boundary = createGitHubAppBetaHttpBoundary({ environment: environment(root) });
  const port = await listen(t, boundary);
  const body = Buffer.from(JSON.stringify(pullRequestPayload()), 'utf8');
  const headers = {
    'x-github-event': 'pull_request',
    'x-github-delivery': DELIVERY,
    'x-hub-signature-256': signature(body),
  };

  const first = await request(port, { body, headers });
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.ok, true);
  assert.equal(first.body.duplicate, false);
  assert.match(first.body.receiptHash, /^[0-9a-f]{64}$/);

  const second = await request(port, { body, headers });
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.receiptHash, first.body.receiptHash);

  const receiptFiles = fs.readdirSync(path.join(root, 'receipts'));
  assert.deepEqual(receiptFiles, [`${DELIVERY}.json`]);
  const stored = fs.readFileSync(path.join(root, 'receipts', receiptFiles[0]), 'utf8');
  assert.doesNotMatch(stored, /private body|private-ref|private-sender|must not be stored/);
});

test('same GitHub delivery GUID with a different authenticated body returns conflict', async (t) => {
  const root = tempRoot(t);
  const boundary = createGitHubAppBetaHttpBoundary({ environment: environment(root) });
  const port = await listen(t, boundary);
  const firstBody = Buffer.from(JSON.stringify(pullRequestPayload('opened')), 'utf8');
  const common = {
    'x-github-event': 'pull_request',
    'x-github-delivery': DELIVERY,
  };
  assert.equal((await request(port, {
    body: firstBody,
    headers: { ...common, 'x-hub-signature-256': signature(firstBody) },
  })).statusCode, 200);

  const changedBody = Buffer.from(JSON.stringify(pullRequestPayload('synchronize')), 'utf8');
  const conflict = await request(port, {
    body: changedBody,
    headers: { ...common, 'x-hub-signature-256': signature(changedBody) },
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.body.error.code, 'GITHUB_APP_DELIVERY_CONFLICT');
});

test('invalid signature and unknown paths fail before receipt persistence', async (t) => {
  const root = tempRoot(t);
  const boundary = createGitHubAppBetaHttpBoundary({ environment: environment(root) });
  const port = await listen(t, boundary);
  const body = Buffer.from(JSON.stringify(pullRequestPayload()), 'utf8');

  const invalid = await request(port, {
    body,
    headers: {
      'x-github-event': 'pull_request',
      'x-github-delivery': DELIVERY,
      'x-hub-signature-256': `sha256=${'0'.repeat(64)}`,
    },
  });
  assert.equal(invalid.statusCode, 401);
  assert.equal(fs.readdirSync(path.join(root, 'receipts')).length, 0);

  const unknown = await request(port, {
    pathname: '/not-a-webhook',
    body,
    headers: { 'x-hub-signature-256': signature(body) },
  });
  assert.equal(unknown.statusCode, 404);
});

test('chunked body crossing the stream bound returns 413 without persisting a receipt', async (t) => {
  const root = tempRoot(t);
  const boundary = createGitHubAppBetaHttpBoundary({ environment: environment(root) });
  const port = await listen(t, boundary);

  const result = await requestChunked(port, [
    Buffer.alloc(MAX_WEBHOOK_BYTES, 0x61),
    Buffer.from('b'),
  ]);

  assert.equal(result.statusCode, 413);
  assert.equal(result.body.error.code, 'GITHUB_APP_PAYLOAD_TOO_LARGE');
  assert.equal(fs.readdirSync(path.join(root, 'receipts')).length, 0);
});

test('GitHub ping is HMAC-authenticated but never creates a Trust Receipt', async (t) => {
  const root = tempRoot(t);
  const boundary = createGitHubAppBetaHttpBoundary({ environment: environment(root) });
  const port = await listen(t, boundary);
  const body = Buffer.from(JSON.stringify({ zen: 'Keep it logically awesome.' }), 'utf8');
  const result = await request(port, {
    body,
    headers: {
      'x-github-event': 'ping',
      'x-github-delivery': DELIVERY,
      'x-hub-signature-256': signature(body),
    },
  });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { ok: true, event: 'ping' });
  assert.equal(fs.readdirSync(path.join(root, 'receipts')).length, 0);
});
