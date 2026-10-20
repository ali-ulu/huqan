'use strict';

// #4088: operator reconciliation of a Streaming Trust writeback that an
// ambiguous check-run network outcome left durably 'started'. The three
// behaviours under test are the issue's acceptance criteria: commit from what
// GitHub already has, never write twice without explicit confirmation, and
// never print the installation token.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { reconcileGitHubAppWriteback } = require('./github-app-reconcile-writeback');
const { createGitHubAppStreamingTrustStore } = require('../lib/github-app-streaming-trust-store');
const { buildStreamingTrustReceipt, checkExternalId, evaluateEvidence } = require('../lib/github-app-streaming-trust-receipt');

const DELIVERY = '82d3162e-cc78-11e3-81ab-4c9367dc0958';
const REPOSITORY_ID = 1300995136;
const REPOSITORY_FULL_NAME = 'ali-ulu/huqan';
const INSTALLATION_ID = 991;
const PR_NUMBER = 280;
const HEAD_SHA = 'b'.repeat(40);
const NOW_MS = Date.parse('2026-08-14T00:30:00.000Z');
const TOKEN = 'ghs_reconcile_test_token_must_not_print';
const C7_HASH = 'a'.repeat(64);

function binding() {
  return Object.freeze({
    deliveryId: DELIVERY,
    repositoryId: REPOSITORY_ID,
    repositoryFullName: REPOSITORY_FULL_NAME,
    installationId: INSTALLATION_ID,
    pullRequestNumber: PR_NUMBER,
    headSha: HEAD_SHA,
    c7ReceiptHash: C7_HASH,
  });
}

function privateKey() {
  return crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
}

// Seed the durable state an ambiguous check-run write leaves behind: an
// evaluation, and a writeback reservation whose outcome nobody knows.
function seedStartedWriteback(t) {
  const rootPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-reconcile-')));
  t.after(() => fs.rmSync(rootPath, { recursive: true, force: true }));
  const store = createGitHubAppStreamingTrustStore({ rootPath });
  const evidence = {
    files: [{ path: 'docs/reconciled.md', status: 'modified', changeType: 'source', additions: 1, deletions: 0 }],
    fileCount: 1,
    totalAdditions: 1,
    totalDeletions: 0,
  };
  const gate = evaluateEvidence(binding(), evidence);
  const receipt = buildStreamingTrustReceipt({ binding: binding(), evidence, gate, nowMs: NOW_MS });
  store.commitEvaluation(binding(), receipt);
  const externalId = checkExternalId(binding(), receipt);
  store.reserveWriteback({
    binding: binding(),
    receiptHash: receipt.receiptHash,
    externalId,
    startedAt: new Date(NOW_MS).toISOString(),
  });
  return { rootPath, store, externalId };
}

function responseJson(value, ok = true) {
  return { ok, async json() { return value; } };
}

function makeFetch({ listing = [], listFails = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`) {
      return responseJson({ token: TOKEN, expires_at: '2026-08-14T01:30:00.000Z' });
    }
    if (url.startsWith(`https://api.github.com/repos/${REPOSITORY_FULL_NAME}/commits/${HEAD_SHA}/check-runs?`)) {
      if (listFails) throw new Error('simulated listing ambiguity');
      return responseJson({ total_count: listing.length, check_runs: listing });
    }
    if (url === `https://api.github.com/repos/${REPOSITORY_FULL_NAME}/check-runs`) {
      const body = JSON.parse(options.body);
      return responseJson({ id: 445566, head_sha: body.head_sha });
    }
    throw new Error(`unexpected GitHub URL: ${url}`);
  };
  return { fetchImpl, calls };
}

function capture() {
  const chunks = [];
  return {
    write: (text) => { chunks.push(text); },
    output: () => chunks.join(''),
  };
}

const reconcileArgs = (seed, github, extra = {}) => ({
  deliveryId: DELIVERY,
  rootPath: seed.rootPath,
  appId: '123456',
  privateKey: privateKey(),
  fetchImpl: github.fetchImpl,
  nowMs: NOW_MS,
  ...extra,
});

const postedChecks = (github) => github.calls
  .filter((call) => call.options.method === 'POST' && call.url.endsWith('/check-runs'));

test('reconcile commits a started writeback when GitHub already has the check with the same external id', async (t) => {
  const seed = seedStartedWriteback(t);
  const github = makeFetch({ listing: [{ id: 445566, external_id: seed.externalId, conclusion: 'failure' }] });
  const out = capture();

  const result = await reconcileGitHubAppWriteback(reconcileArgs(seed, github, { write: out.write }));

  assert.equal(result.status, 'committed');
  assert.equal(result.checkRunId, 445566);
  const record = seed.store.readWriteback(DELIVERY);
  assert.equal(record.state, 'complete');
  assert.equal(record.checkRunId, 445566);
  // Reconciling is not writing: GitHub already had the check, so none is created.
  assert.equal(postedChecks(github).length, 0);
});

test('reconcile never writes a second check without explicit operator confirmation', async (t) => {
  const seed = seedStartedWriteback(t);
  const github = makeFetch({ listing: [] });
  const out = capture();

  const result = await reconcileGitHubAppWriteback(reconcileArgs(seed, github, { write: out.write }));

  assert.equal(result.status, 'needs-confirmation');
  assert.equal(seed.store.readWriteback(DELIVERY).state, 'started');
  assert.equal(postedChecks(github).length, 0);
  assert.match(out.output(), /--confirm/);

  // With the confirmation, exactly one write happens and the record completes.
  const seeded = seedStartedWriteback(t);
  const confirmed = makeFetch({ listing: [] });
  const confirmedResult = await reconcileGitHubAppWriteback(reconcileArgs(seeded, confirmed, {
    confirm: true,
    write: () => {},
  }));
  assert.equal(confirmedResult.status, 'rewritten');
  assert.equal(seeded.store.readWriteback(DELIVERY).state, 'complete');
  assert.equal(postedChecks(confirmed).length, 1);
});

test('reconcile output never contains the installation token', async (t) => {
  const seed = seedStartedWriteback(t);
  const failing = makeFetch({ listFails: true });
  const failingOut = capture();

  await assert.rejects(
    () => reconcileGitHubAppWriteback(reconcileArgs(seed, failing, { write: failingOut.write })),
  );
  assert.equal(failingOut.output().includes(TOKEN), false);

  const seeded = seedStartedWriteback(t);
  const github = makeFetch({ listing: [{ id: 445566, external_id: seeded.externalId, conclusion: 'failure' }] });
  const out = capture();
  await reconcileGitHubAppWriteback(reconcileArgs(seeded, github, { write: out.write }));
  assert.equal(out.output().includes(TOKEN), false);
});
