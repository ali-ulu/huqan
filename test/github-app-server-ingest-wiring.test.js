'use strict';

/**
 * #3027: the published GitHub App beta server must actually queue repo ingest.
 *
 * `lib/github-app-beta-http-boundary.js` only submits a pull-request
 * observation for review when it is handed `options.queueIngest`, and the
 * published `github-app-server.js` used to build its boundary without one --
 * so a real deployment recorded the observation receipt but never created the
 * `http.ingest` approval #3032's pipeline produces. This exercises the real
 * production server: `startGitHubAppBetaServer` with no injected boundary, its
 * own submitter, the product's `createIngestApprovalRuntime`, and a real
 * SQLite store.
 *
 * The boundary is invoked directly with a fake request rather than over a
 * socket: the request surface it reads (`method`, `headers`,
 * `headersDistinct`, and the `data`/`end` events) is small, and a socket only
 * adds a Windows hang risk. The observation-only behavior of
 * `lib/github-app-beta-handler.js` is untouched and still asserted by
 * `test/v5-c7-github-app-beta.test.js`.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createProductionServer } = require('../github-app-server');
const HuqanStorage = require('../storage');

const SECRET = 'github-app-server-ingest-wiring-secret';
const DELIVERY = '1f0f4e6a-1d3c-4b3e-9a2f-2b6f6a1c0d3e';
const SHA = 'c'.repeat(40);

function tempRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-app-ingest-')));
}

function removeTempRoot(root) {
  // Windows refuses to unlink an open SQLite file (EBUSY), so every store must
  // be closed before this runs; callers register it in one ordered teardown.
  fs.rmSync(root, { recursive: true, force: true });
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

function fakeRequest(body) {
  const headers = {
    'content-type': 'application/json',
    'content-length': String(body.length),
    'x-github-event': 'pull_request',
    'x-github-delivery': DELIVERY,
    'x-hub-signature-256': `sha256=${crypto.createHmac('sha256', SECRET).update(body).digest('hex')}`,
  };
  const req = new EventEmitter();
  req.method = 'POST';
  req.headers = headers;
  req.headersDistinct = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, [value]]));
  // Deliver on the next tick so the boundary has attached its listeners.
  process.nextTick(() => {
    req.emit('data', body);
    req.emit('end');
  });
  return req;
}

// The production server, built exactly as `require.main` builds it -- no
// injected boundary and no injected callback -- but without binding a port.
// Teardown closes every store before the temp root is removed (Windows EBUSY).
function productionServer(t, root) {
  const server = createProductionServer({ environment: environment(root) });
  const submitter = server.ingestSubmitter;
  t.after(() => {
    submitter.close();
    submitter.kernel.graph.close();
    removeTempRoot(root);
  });
  return server;
}

test('the production server queues a durable pending ingest approval', async (t) => {
  const root = tempRoot();
  const server = productionServer(t, root);
  assert.ok(server.ingestSubmitter, 'the production server must wire a repo-ingest submitter');

  const body = Buffer.from(JSON.stringify(pullRequestPayload()), 'utf8');
  const result = await server.boundary.handle(fakeRequest(body));

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
  const pending = storage.listPendingToolApprovals(20, 'default');
  const context = JSON.parse(pending[0].context_json);
  storage.close();
  assert.strictEqual(pending.length, 1);
  assert.strictEqual(pending[0].tool, 'http.ingest');
  assert.strictEqual(pending[0].decision, 'review');
  assert.strictEqual(context.snapshot.sourceType, 'github');
  assert.strictEqual(context.snapshot.payload.commitSha, SHA);
});

test('a repeated delivery is idempotent and does not queue a second approval', async (t) => {
  const root = tempRoot();
  const server = productionServer(t, root);

  const body = Buffer.from(JSON.stringify(pullRequestPayload()), 'utf8');
  const first = await server.boundary.handle(fakeRequest(body));
  const second = await server.boundary.handle(fakeRequest(body));

  assert.strictEqual(first.body.ingest.idempotent, false);
  assert.strictEqual(second.body.ingest.idempotent, true);
  assert.strictEqual(
    second.body.ingest.approval.id,
    first.body.ingest.approval.id,
    'the same observation must resolve to the same approval',
  );

  const storage = new HuqanStorage({ kernel: server.ingestSubmitter.kernel });
  const pending = storage.listPendingToolApprovals(20, 'default');
  storage.close();
  assert.strictEqual(pending.length, 1);
});

test('an injected boundary keeps its own queueing decision', () => {
  const boundary = {
    path: '/api/github-app/webhook',
    handle: async () => ({ statusCode: 200, headers: {}, body: { ok: true } }),
  };
  const server = createProductionServer({
    environment: { HUQAN_GITHUB_APP_BETA_ENABLED: '1' },
    boundary,
  });
  assert.strictEqual(server.ingestSubmitter, null);
});
