'use strict';

// #4088 (ENT-TL5): the operator reconciliation tool for a Streaming Trust
// writeback that is stuck in the ambiguous `started` state.
//
// The scenario is real, not constructed: the delivery below really runs the C8
// loop, the check-run write really fails with an unclear network outcome, and
// the store really is left in `started` afterwards. Everything the tool does
// is then measured against that state.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const { createGitHubAppStreamingTrustStore } = require('../lib/github-app-streaming-trust-store');
const { runGitHubAppStreamingTrust } = require('../lib/github-app-streaming-trust');
const { OUTCOMES, main, reconcileWriteback } = require('./github-app-reconcile-writeback');

const DELIVERY = '82d3162e-cc78-11e3-81ab-4c9367dc0958';
const REPOSITORY_ID = 1300995136;
const REPOSITORY_FULL_NAME = 'ali-ulu/huqan';
const INSTALLATION_ID = 991;
const PR_NUMBER = 280;
const HEAD_SHA = 'b'.repeat(40);
const NOW_MS = Date.parse('2026-08-14T00:30:00.000Z');
const TOKEN = 'ghs_streaming_reconcile_test_token';
const CHECK_RUNS_URL = `https://api.github.com/repos/${REPOSITORY_FULL_NAME}/check-runs`;
const SCRIPT = path.join(__dirname, 'github-app-reconcile-writeback.js');
// The production shape: the deployment reads the key from a PEM file.
const PRIVATE_KEY = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' });

function responseJson(value, ok = true) {
  return { ok, async json() { return value; } };
}

/**
 * One fake GitHub for both stages: the delivery that ends ambiguously, and
 * the reconciliation that follows it.
 */
function makeGitHubFetch() {
  const state = { checkRuns: [], failCheckWrite: true, listBody: null, calls: [] };
  const fetchImpl = async (url, options = {}) => {
    state.calls.push({ url, options });
    if (url === `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`) {
      return responseJson({ token: TOKEN, expires_at: '2026-08-14T01:30:00.000Z' });
    }
    if (url === `https://api.github.com/repos/${REPOSITORY_FULL_NAME}/pulls/${PR_NUMBER}`) {
      return responseJson({
        number: PR_NUMBER,
        base: { repo: { id: REPOSITORY_ID, full_name: REPOSITORY_FULL_NAME } },
        head: { sha: HEAD_SHA },
      });
    }
    if (url.startsWith(`https://api.github.com/repos/${REPOSITORY_FULL_NAME}/pulls/${PR_NUMBER}/files?`)) {
      const page = Number(new URL(url).searchParams.get('page'));
      const files = [{ filename: 'docs/streaming.md', status: 'modified', additions: 3, deletions: 1 }];
      return responseJson(files.slice((page - 1) * 100, page * 100));
    }
    if (url.startsWith(`https://api.github.com/repos/${REPOSITORY_FULL_NAME}/commits/${HEAD_SHA}/check-runs?`)) {
      if (state.listBody) return responseJson(state.listBody);
      return responseJson({ total_count: state.checkRuns.length, check_runs: state.checkRuns });
    }
    if (url === CHECK_RUNS_URL) {
      if (state.failCheckWrite) throw new Error('simulated network ambiguity');
      const body = JSON.parse(options.body);
      return responseJson({ id: 445566, head_sha: body.head_sha });
    }
    throw new Error(`unexpected GitHub URL: ${url}`);
  };
  return { fetchImpl, state };
}

function c7Result() {
  return {
    binding: {
      deliveryId: DELIVERY,
      repositoryId: REPOSITORY_ID,
      repositoryFullName: REPOSITORY_FULL_NAME,
      installationId: INSTALLATION_ID,
      pullRequestNumber: PR_NUMBER,
      headSha: HEAD_SHA,
    },
    receipt: { receiptHash: 'a'.repeat(64) },
  };
}

/** Run the delivery until the writeback write has an unclear outcome. */
async function ambiguousDelivery(t) {
  const rootPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-c8-reconcile-')));
  t.after(() => fs.rmSync(rootPath, { recursive: true, force: true }));
  const store = createGitHubAppStreamingTrustStore({ rootPath });
  const github = makeGitHubFetch();

  await assert.rejects(
    () => runGitHubAppStreamingTrust({
      c7Result: c7Result(),
      appId: '123456',
      privateKey: PRIVATE_KEY,
      store,
      fetchImpl: github.fetchImpl,
      nowMs: NOW_MS,
    }),
    (error) => error.code === 'GITHUB_APP_STREAMING_WRITEBACK_FAILED',
  );
  assert.equal(store.readWriteback(DELIVERY).state, 'started');
  return { rootPath, store, github };
}

function reconcile(store, github, extra = {}) {
  return reconcileWriteback({
    deliveryId: DELIVERY,
    store,
    appId: '123456',
    privateKey: PRIVATE_KEY,
    fetchImpl: github.fetchImpl,
    nowMs: NOW_MS + 60000,
    ...extra,
  });
}

function checkWrites(calls) {
  return calls.filter((call) => call.url === CHECK_RUNS_URL);
}

function deploymentEnvironment(rootPath) {
  const keyPath = path.join(rootPath, 'app-key.pem');
  fs.writeFileSync(keyPath, PRIVATE_KEY);
  return {
    HUQAN_GITHUB_APP_STORE_PATH: rootPath,
    HUQAN_GITHUB_APP_ID: '123456',
    HUQAN_GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
    HUQAN_GITHUB_APP_STREAMING_TRUST_ENABLED: '1',
  };
}

test('reconcile commits a started writeback when GitHub already has the check with the same external id', async (t) => {
  const { store, github } = await ambiguousDelivery(t);
  const externalId = store.readWriteback(DELIVERY).externalId;
  github.state.checkRuns = [{ id: 445566, name: 'HUQAN Streaming Trust', external_id: externalId, head_sha: HEAD_SHA }];
  github.state.failCheckWrite = false;
  const callsBefore = github.state.calls.length;

  const outcome = await reconcile(store, github);

  assert.equal(outcome.outcome, OUTCOMES.RECONCILED);
  assert.equal(outcome.checkRunId, 445566);
  assert.equal(outcome.wroteCheck, false);
  // The record is closed without a second check: the write had landed.
  assert.equal(checkWrites(github.state.calls.slice(callsBefore)).length, 0);
  const stored = store.readWriteback(DELIVERY);
  assert.equal(stored.state, 'complete');
  assert.equal(stored.checkRunId, 445566);
  assert.equal(stored.externalId, externalId);
});

test('reconcile never writes a second check without explicit operator confirmation', async (t) => {
  const { store, github } = await ambiguousDelivery(t);
  // GitHub holds a check for this head, but not the one this delivery wrote:
  // a declined check carries its own external id.
  github.state.checkRuns = [{ id: 999, name: 'HUQAN Streaming Trust', external_id: 'huqan:c8:declined:0'.padEnd(64, '0') }];
  github.state.failCheckWrite = false;
  const callsBefore = github.state.calls.length;

  const outcome = await reconcile(store, github);

  assert.equal(outcome.outcome, OUTCOMES.CHECK_ABSENT);
  assert.equal(outcome.wroteCheck, false);
  assert.equal(checkWrites(github.state.calls.slice(callsBefore)).length, 0);
  // Nothing was written, so the record stays ambiguous rather than being
  // closed on the strength of a check that is not there.
  assert.equal(store.readWriteback(DELIVERY).state, 'started');
});

test('reconcile writes the check once when the operator confirms the rewrite', async (t) => {
  const { store, github } = await ambiguousDelivery(t);
  github.state.checkRuns = [];
  github.state.failCheckWrite = false;
  const callsBefore = github.state.calls.length;

  const outcome = await reconcile(store, github, { confirmRewrite: true });

  assert.equal(outcome.outcome, OUTCOMES.REWRITTEN);
  assert.equal(outcome.wroteCheck, true);
  assert.equal(outcome.checkRunId, 445566);
  assert.equal(checkWrites(github.state.calls.slice(callsBefore)).length, 1);
  const stored = store.readWriteback(DELIVERY);
  assert.equal(stored.state, 'complete');
  assert.equal(stored.checkRunId, 445566);
});

test('reconcile output never contains the installation token', async (t) => {
  const { rootPath, store, github } = await ambiguousDelivery(t);
  const externalId = store.readWriteback(DELIVERY).externalId;
  github.state.checkRuns = [{ id: 445566, name: 'HUQAN Streaming Trust', external_id: externalId, head_sha: HEAD_SHA }];
  const lines = [];

  const code = await main(['--delivery', DELIVERY], {
    environment: deploymentEnvironment(rootPath),
    fetchImpl: github.fetchImpl,
    nowMs: NOW_MS + 60000,
    write: (text) => lines.push(text),
  });

  assert.equal(code, 0);
  const output = lines.join('\n');
  assert.match(output, /outcome: reconciled/);
  assert.equal(output.includes(TOKEN), false);
  assert.equal(JSON.stringify(store.readWriteback(DELIVERY)).includes(TOKEN), false);
});

test('reconcile refuses a delivery whose writeback is not ambiguous', async (t) => {
  const { store, github } = await ambiguousDelivery(t);
  github.state.failCheckWrite = false;

  await assert.rejects(
    () => reconcileWriteback({
      deliveryId: '00000000-0000-4000-8000-000000000000',
      store,
      appId: '123456',
      privateKey: PRIVATE_KEY,
      fetchImpl: github.fetchImpl,
      nowMs: NOW_MS + 60000,
    }),
    (error) => error.code === 'GITHUB_APP_STREAMING_INVALID_INPUT',
  );
});

test('reconcile refuses a writeback record that does not match its evaluation', async (t) => {
  const { rootPath, store, github } = await ambiguousDelivery(t);
  const recordPath = path.join(rootPath, 'streaming-trust', 'writeback-started', `${DELIVERY}.json`);
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  record.externalId = 'huqan:c8:someone-elses-write';
  fs.writeFileSync(recordPath, JSON.stringify(record));

  await assert.rejects(
    () => reconcile(store, github),
    (error) => error.code === 'GITHUB_APP_STREAMING_WRITEBACK_STATE_UNKNOWN',
  );
  assert.equal(store.readWriteback(DELIVERY).state, 'started');
});

test('reconcile refuses answers it cannot read', async (t) => {
  const { store, github } = await ambiguousDelivery(t);
  const externalId = store.readWriteback(DELIVERY).externalId;
  const cases = [
    { name: 'a list that is not a list', body: { check_runs: 'nope' } },
    { name: 'two runs with the same external id', body: { check_runs: [{ id: 1, external_id: externalId }, { id: 2, external_id: externalId }] } },
    { name: 'a run without an id', body: { check_runs: [{ id: 0, external_id: externalId }] } },
  ];

  for (const item of cases) {
    github.state.listBody = item.body;
    await assert.rejects(
      () => reconcile(store, github),
      (error) => error.code === 'GITHUB_APP_STREAMING_WRITEBACK_RESPONSE_INVALID',
      item.name,
    );
  }
  assert.equal(store.readWriteback(DELIVERY).state, 'started');
});

test('reconcile reports a writeback that is already complete', async (t) => {
  const { store, github } = await ambiguousDelivery(t);
  const externalId = store.readWriteback(DELIVERY).externalId;
  github.state.checkRuns = [{ id: 445566, name: 'HUQAN Streaming Trust', external_id: externalId, head_sha: HEAD_SHA }];
  github.state.failCheckWrite = false;
  await reconcile(store, github);
  const callsBefore = github.state.calls.length;

  const outcome = await reconcile(store, github);

  assert.equal(outcome.outcome, OUTCOMES.ALREADY_COMPLETE);
  assert.equal(outcome.checkRunId, 445566);
  // Nothing was asked of GitHub: the record was already closed.
  assert.equal(github.state.calls.length, callsBefore);
});

test('the reconcile command prints its usage when it is asked for help', async () => {
  const lines = [];
  const code = await main(['--help'], { write: (text) => lines.push(text) });

  assert.equal(code, 0);
  assert.match(lines.join('\n'), /usage: node scripts\/github-app-reconcile-writeback\.js/);
});

test('the reconcile command reports a deployment without Streaming Trust enabled', async (t) => {
  const { rootPath } = await ambiguousDelivery(t);
  const environment = deploymentEnvironment(rootPath);
  delete environment.HUQAN_GITHUB_APP_STREAMING_TRUST_ENABLED;
  const lines = [];

  const code = await main(['--delivery', DELIVERY], { environment, write: (text) => lines.push(text) });

  assert.equal(code, 2);
  assert.match(lines.join('\n'), /does not have Streaming Trust enabled/);
});

test('the reconcile command refuses an argument it does not know', async () => {
  await assert.rejects(
    () => main(['--rewrite-everything'], { write: () => {} }),
    (error) => error.code === 'GITHUB_APP_STREAMING_INVALID_INPUT',
  );
  await assert.rejects(
    () => main(['--delivery'], { write: () => {} }),
    (error) => error.code === 'GITHUB_APP_STREAMING_INVALID_INPUT',
  );
});

test('the reconcile command exits with a code when it cannot reconcile', async (t) => {
  const { rootPath } = await ambiguousDelivery(t);
  const child = spawnSync(process.execPath, [SCRIPT, '--delivery', DELIVERY], {
    encoding: 'utf8',
    env: { ...process.env, ...deploymentEnvironment(rootPath) },
  });

  assert.equal(child.status, 1);
  assert.match(child.stderr, /github-app-reconcile-writeback: /);
  assert.equal(child.stderr.includes(TOKEN), false);
});
