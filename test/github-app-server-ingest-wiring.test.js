'use strict';

/**
 * #3027: the published GitHub App beta server must actually queue repo ingest.
 *
 * `lib/github-app-beta-http-boundary.js` only submits a pull-request
 * observation for review when it is handed `options.queueIngest`, and the
 * published `github-app-server.js` used to build its boundary without one --
 * so a real deployment recorded the observation receipt but never created the
 * `http.ingest` approval #3032's pipeline produces. This exercises the real
 * production path: the boundary the server builds, the product's own
 * `createIngestApprovalRuntime`, and a real SQLite approval store.
 *
 * The observation-only behavior of `lib/github-app-beta-handler.js` is
 * untouched and still asserted by `test/v5-c7-github-app-beta.test.js`; here
 * the webhook only has to leave a durable pending approval behind.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { startGitHubAppBetaServer } = require('../github-app-server');
const HuqanStorage = require('../storage');

const SECRET = 'github-app-server-ingest-wiring-secret';
const DELIVERY = '1f0f4e6a-1d3c-4b3e-9a2f-2b6f6a1c0d3e';
const SHA = 'c'.repeat(40);

function tempRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-app-ingest-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function environment(root) {
  return {
    HUQAN_GITHUB_APP_BETA_ENABLED: '1',
    HUQAN_GITHUB_APP_WEBHOOK_SECRET: SECRET,
    HUQAN_GITHUB_APP_STORE_PATH: root,
    // The submitter derives the approval store from this path (`memory.json`
    // -> `memory.db`), so both live inside the temp root.
    HUQAN_MEMORY_PATH: path.join(root, 'memory.json'),
  };
}

function pullRequestPayload() {
  return {
    action: 'opened',
    number: 279,
    installation: { id: 991 },
    repository: { id: 1300995136, full_name: 'ali-ulu/huqan' },
    pull_request: { number: 279, head: { sha: SHA } },
  };
}

function signature(body) {
  return `sha256=${crypto.createHmac('sha256', SECRET).update(body).digest('hex')}`;
}

function listen(server) {
  return new Promise((resolve) => server.once('listening', resolve));
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function post(port, body, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/github-app/webhook',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(body.length),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    req.once('error', reject);
    req.end(body);
  });
}

test('the production GitHub App server queues a durable pending ingest approval', async (t) => {
  const root = tempRoot(t);
  const server = startGitHubAppBetaServer({ environment: environment(root), port: 0 });
  t.after(async () => {
    await closeServer(server);
    if (server.ingestSubmitter) server.ingestSubmitter.close();
  });
  await listen(server);
  const port = server.address().port;

  const body = Buffer.from(JSON.stringify(pullRequestPayload()), 'utf8');
  const result = await post(port, body, {
    'x-github-event': 'pull_request',
    'x-github-delivery': DELIVERY,
    'x-hub-signature-256': signature(body),
  });

  assert.strictEqual(result.statusCode, 200);
  assert.strictEqual(result.body.ok, true);
  assert.strictEqual(result.body.ingest.queued, true);
  assert.strictEqual(result.body.ingest.status, 202);
  assert.strictEqual(result.body.ingest.idempotent, false);
  assert.strictEqual(result.body.ingest.approval.status, 'pending');
  assert.strictEqual(result.body.ingest.approval.sourceType, 'github');
  assert.strictEqual(result.body.ingest.approval.sourceRef, `https://github.com/ali-ulu/huqan#${SHA}`);

  // Durable: the approval is in the same store a human would decide from, not
  // only in the HTTP response.
  const storage = new HuqanStorage({ kernel: server.ingestSubmitter.kernel });
  t.after(() => storage.close());
  const pending = storage.listPendingToolApprovals(20, 'default');
  assert.strictEqual(pending.length, 1);
  const context = JSON.parse(pending[0].context_json);
  assert.strictEqual(pending[0].tool, 'http.ingest');
  assert.strictEqual(pending[0].decision, 'review');
  assert.strictEqual(context.snapshot.sourceType, 'github');
  assert.strictEqual(context.snapshot.payload.commitSha, SHA);
});

test('a repeated delivery is idempotent and does not queue a second approval', async (t) => {
  const root = tempRoot(t);
  const server = startGitHubAppBetaServer({ environment: environment(root), port: 0 });
  t.after(async () => {
    await closeServer(server);
    if (server.ingestSubmitter) server.ingestSubmitter.close();
  });
  await listen(server);
  const port = server.address().port;

  const body = Buffer.from(JSON.stringify(pullRequestPayload()), 'utf8');
  const headers = {
    'x-github-event': 'pull_request',
    'x-github-delivery': DELIVERY,
    'x-hub-signature-256': signature(body),
  };
  const first = await post(port, body, headers);
  const second = await post(port, body, headers);

  assert.strictEqual(first.body.ingest.idempotent, false);
  assert.strictEqual(second.body.ingest.idempotent, true);
  assert.strictEqual(
    second.body.ingest.approval.id,
    first.body.ingest.approval.id,
    'the same observation must resolve to the same approval',
  );
});

test('an injected boundary keeps its own queueing decision', async (t) => {
  const root = tempRoot(t);
  const boundary = {
    path: '/api/github-app/webhook',
    handle: async () => ({ statusCode: 200, headers: {}, body: { ok: true } }),
  };
  const server = startGitHubAppBetaServer({ environment: environment(root), boundary, port: 0 });
  t.after(() => closeServer(server));
  await listen(server);
  assert.strictEqual(server.ingestSubmitter, null);
});
