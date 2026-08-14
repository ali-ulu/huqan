'use strict';

/**
 * #694: the Streaming Trust loop reached over a real HTTP request.
 *
 * The tests in v5-c8-streaming-trust.test.js call the loop directly. That
 * proves the loop and proves nothing about whether anything can reach it --
 * which was exactly the gap: four modules sat in NOT_YET_WIRED, and a
 * webhook had never arrived at any of them.
 *
 * So the inbound half here is real: a real server, a real socket, a real
 * signed POST, parsed by the real boundary. Only the outbound GitHub API is
 * injected, because the alternative is calling github.com from a unit test.
 * The seam is `fetchImpl` on the boundary, the same shape as `environment`.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createGitHubAppBetaHttpBoundary,
} = require('../lib/github-app-beta-http-boundary');
const { createGitHubAppBetaServer } = require('../github-app-server');
const { ERROR_CODES, MAX_FILES } = require('../lib/github-app-streaming-trust');

const SECRET = 'github-app-streaming-http-secret';
const DELIVERY = '52d3162e-cc78-11e3-81ab-4c9367dc0958';
const REPOSITORY_ID = 1300995136;
const REPOSITORY_FULL_NAME = 'ali-ulu/huqan';
const INSTALLATION_ID = 991;
const PR_NUMBER = 694;
const HEAD_SHA = 'd'.repeat(40);
const APP_ID = '123456';

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-c8-http-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writePrivateKey(root) {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPath = path.join(root, 'app-private-key.pem');
  fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs1', format: 'pem' }), { mode: 0o600 });
  return keyPath;
}

function environment(root, overrides = {}) {
  return {
    HUQAN_GITHUB_APP_BETA_ENABLED: '1',
    HUQAN_GITHUB_APP_WEBHOOK_SECRET: SECRET,
    HUQAN_GITHUB_APP_STORE_PATH: root,
    HUQAN_GITHUB_APP_STREAMING_TRUST_ENABLED: '1',
    HUQAN_GITHUB_APP_ID: APP_ID,
    HUQAN_GITHUB_APP_PRIVATE_KEY_PATH: writePrivateKey(root),
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

function githubApi({
  files = [{ filename: 'docs/streaming.md', status: 'modified', additions: 3, deletions: 1 }],
  liveHeadSha = HEAD_SHA,
  checkRunId = 778899,
  checkFailure = null,
} = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/access_tokens')) {
      return responseJson({ token: 'ghs_http_test_token', expires_at: '2099-01-01T00:00:00.000Z' });
    }
    if (url.endsWith(`/pulls/${PR_NUMBER}`)) {
      return responseJson({
        number: PR_NUMBER,
        base: { repo: { id: REPOSITORY_ID, full_name: REPOSITORY_FULL_NAME } },
        head: { sha: liveHeadSha },
      });
    }
    if (url.includes(`/pulls/${PR_NUMBER}/files?`)) {
      const page = Number(new URL(url).searchParams.get('page'));
      return responseJson(files.slice((page - 1) * 100, page * 100));
    }
    if (url.endsWith('/check-runs')) {
      if (checkFailure === 'throw') throw new Error('simulated network ambiguity');
      return responseJson({ id: checkRunId, head_sha: JSON.parse(options.body).head_sha });
    }
    throw new Error(`unexpected GitHub URL: ${url}`);
  };
  return { fetchImpl, calls };
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

function post(port, { body, deliveryId = DELIVERY, signWith = SECRET, event = 'pull_request' }) {
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
        'x-github-event': event,
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': `sha256=${crypto.createHmac('sha256', signWith).update(raw).digest('hex')}`,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ statusCode: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null });
      });
    });
    req.once('error', reject);
    req.end(raw);
  });
}

async function serve(t, apiOptions = {}, envOverrides = {}) {
  const root = tempRoot(t);
  const api = githubApi(apiOptions);
  const boundary = createGitHubAppBetaHttpBoundary({
    environment: environment(root, envOverrides),
    fetchImpl: api.fetchImpl,
  });
  return { root, api, boundary, port: await listen(t, boundary) };
}

test('a signed webhook reaches the Streaming Trust loop over a real request and writes a check run', async (t) => {
  const { api, port } = await serve(t);

  const response = await post(port, { body: payload() });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.evaluated, true);
  assert.equal(response.body.trust.verdict, 'allow');
  assert.equal(response.body.trust.conclusion, 'success');
  assert.equal(response.body.trust.checkRunId, 778899);
  assert.match(response.body.trust.receiptHash, /^[0-9a-f]{64}$/);
  assert.notEqual(response.body.trust.receiptHash, response.body.receiptHash);

  // The loop really ran: a token was minted, the pull request and its files
  // were read at the delivery head, and a check run was written.
  const urls = api.calls.map(call => call.url);
  assert.equal(urls.filter(url => url.endsWith('/access_tokens')).length, 1);
  assert.equal(urls.filter(url => url.endsWith(`/pulls/${PR_NUMBER}`)).length, 1);
  assert.equal(urls.filter(url => url.includes('/files?')).length, 1);

  const checkBody = JSON.parse(api.calls.find(call => call.url.endsWith('/check-runs')).options.body);
  assert.equal(checkBody.head_sha, HEAD_SHA);
  assert.equal(checkBody.conclusion, 'success');
});

test('the HMAC is verified at the boundary, and a bad signature never reaches the loop', async (t) => {
  const { api, port } = await serve(t);

  const response = await post(port, { body: payload(), signWith: 'wrong-secret' });

  assert.equal(response.statusCode, 401);
  assert.equal(response.body.error.code, 'GITHUB_APP_INVALID_SIGNATURE');
  // Not one outbound call: rejection happens before any credential is spent.
  assert.deepEqual(api.calls, []);
});

test('the streaming loop stays off until its own flag is set, even with the beta flag on', async (t) => {
  const { api, port } = await serve(t, {}, { HUQAN_GITHUB_APP_STREAMING_TRUST_ENABLED: '0' });

  const response = await post(port, { body: payload() });

  // The observation still happens; the outbound write does not.
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.trust, undefined);
  assert.match(response.body.receiptHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(api.calls, []);
});

test('startup fails closed on a missing or unusable private key rather than on the first delivery', async (t) => {
  const root = tempRoot(t);
  const api = githubApi();
  const unusable = path.join(root, 'not-a-key.pem');
  fs.writeFileSync(unusable, 'this is not a private key');

  for (const overrides of [
    { HUQAN_GITHUB_APP_PRIVATE_KEY_PATH: path.join(root, 'absent.pem') },
    { HUQAN_GITHUB_APP_PRIVATE_KEY_PATH: unusable },
    { HUQAN_GITHUB_APP_ID: 'not-a-number' },
    { HUQAN_GITHUB_APP_STREAMING_TRUST_ENABLED: 'yes' },
  ]) {
    assert.throws(
      () => createGitHubAppBetaHttpBoundary({
        environment: environment(root, overrides),
        fetchImpl: api.fetchImpl,
      }),
      (error) => error.code === 'GITHUB_APP_BETA_CONFIG_INVALID',
    );
  }
});

test('a redelivery over HTTP does not write a second check run', async (t) => {
  const { api, port } = await serve(t);

  const first = await post(port, { body: payload() });
  const callsAfterFirst = api.calls.length;
  const second = await post(port, { body: payload() });

  assert.equal(second.statusCode, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.trust.receiptHash, first.body.trust.receiptHash);
  assert.equal(second.body.trust.checkRunId, first.body.trust.checkRunId);
  assert.equal(api.calls.length, callsAfterFirst, 'a replay spends no token and writes no check');
});

// --- the endpoint must not amplify GitHub's redeliveries ------------------

test('a deterministic refusal answers 200 and is recorded on the pull request, not retried', async (t) => {
  const { api, port } = await serve(t, { liveHeadSha: 'e'.repeat(40) });

  const response = await post(port, { body: payload() });

  // 200 because the delivery was received, verified, decided and written down.
  // A 5xx here would invite a redelivery that can only reach the same answer.
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.evaluated, false);
  assert.equal(response.body.declined.code, ERROR_CODES.HEAD_DRIFT);
  assert.equal(response.headers['retry-after'], undefined);

  const declined = api.calls
    .filter(call => call.url.endsWith('/check-runs'))
    .map(call => JSON.parse(call.options.body));
  assert.equal(declined.length, 1);
  assert.equal(declined[0].conclusion, 'action_required');
  assert.equal(declined[0].output.title, 'HUQAN: declined');
});

test('an oversized diff is declined visibly and answered without inviting a redelivery', async (t) => {
  const files = Array.from({ length: MAX_FILES + 1 }, (_, index) => ({
    filename: `docs/file-${index}.md`,
    status: 'modified',
    additions: 1,
    deletions: 0,
  }));
  const { api, port } = await serve(t, { files });

  const response = await post(port, { body: payload() });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.declined.code, ERROR_CODES.EVIDENCE_TOO_LARGE);
  assert.equal(response.headers['retry-after'], undefined);
  assert.equal(api.calls.filter(call => call.url.endsWith('/check-runs')).length, 1);
});

test('an ambiguous writeback stops at a conflict instead of looping on 503', async (t) => {
  const { port } = await serve(t, { checkFailure: 'throw' });

  const first = await post(port, { body: payload() });
  const second = await post(port, { body: payload() });
  const third = await post(port, { body: payload() });

  // The first attempt left the writeback ambiguous. Replay is refused by
  // design, so a redelivery can never do better -- answering 503 would have
  // made GitHub keep asking a question with only one possible answer.
  for (const response of [first, second, third]) {
    assert.notEqual(response.statusCode, 503);
    assert.equal(response.headers['retry-after'], undefined);
  }
  assert.equal(first.body.error.code, ERROR_CODES.WRITEBACK_FAILED);
  assert.equal(first.statusCode, 409);
  assert.equal(second.statusCode, 409);
  assert.equal(second.body.error.code, ERROR_CODES.WRITEBACK_STATE_UNKNOWN);
  assert.equal(third.statusCode, 409);
  assert.equal(third.body.error.code, ERROR_CODES.WRITEBACK_STATE_UNKNOWN);
});

test('no Streaming Trust outcome over HTTP answers with a retry invitation', async (t) => {
  const cases = [
    { name: 'success', api: {} },
    { name: 'head drift', api: { liveHeadSha: 'e'.repeat(40) } },
    { name: 'ambiguous writeback', api: { checkFailure: 'throw' } },
  ];

  for (const item of cases) {
    const { port } = await serve(t, item.api);
    const response = await post(port, { body: payload() });
    assert.notEqual(response.statusCode, 503, `${item.name} must not answer 503`);
    assert.equal(response.headers['retry-after'], undefined, `${item.name} must not send Retry-After`);
  }
});

test('nothing from the webhook payload leaves through the HTTP response or the check run', async (t) => {
  const { api, port } = await serve(t);

  const response = await post(port, { body: payload() });

  const written = JSON.stringify(api.calls.map(call => call.options.body || ''));
  const answered = JSON.stringify(response.body);
  for (const secret of [
    'private-title-must-not-survive',
    'private-body-must-not-survive',
    'private-ref',
    'private-sender',
  ]) {
    assert.equal(written.includes(secret), false);
    assert.equal(answered.includes(secret), false);
  }
});
