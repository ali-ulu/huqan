'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createGitHubAppBetaStore } = require('../lib/github-app-beta-store');
const { createGitHubAppStreamingTrustStore } = require('../lib/github-app-streaming-trust-store');
const { handleGitHubAppStreamingTrustWebhook } = require('../lib/github-app-streaming-trust-handler');
const {
  DECLINED_FALLBACK_CODE,
  ERROR_CODES,
  MAX_FILES,
} = require('../lib/github-app-streaming-trust');
const { toCanonicalVerdict } = require('../lib/verdict/action-verdict');

const SECRET = 'streaming-trust-webhook-secret';
const DELIVERY = '82d3162e-cc78-11e3-81ab-4c9367dc0958';
const REPOSITORY_ID = 1300995136;
const REPOSITORY_FULL_NAME = 'ali-ulu/huqan';
const INSTALLATION_ID = 991;
const PR_NUMBER = 280;
const HEAD_SHA = 'b'.repeat(40);
const NOW_MS = Date.parse('2026-08-14T00:30:00.000Z');

function payload(overrides = {}) {
  return {
    action: 'opened',
    number: PR_NUMBER,
    installation: { id: INSTALLATION_ID },
    repository: { id: REPOSITORY_ID, full_name: REPOSITORY_FULL_NAME, private: false },
    pull_request: {
      number: PR_NUMBER,
      title: 'private-title-must-not-survive',
      body: 'private-body-token-must-not-survive',
      head: { sha: HEAD_SHA, ref: 'private-feature-name' },
    },
    sender: { login: 'private-user', email: 'private@example.invalid' },
    ...overrides,
  };
}

function signedRequest(bodyObject, deliveryId = DELIVERY) {
  const rawBody = Buffer.from(JSON.stringify(bodyObject), 'utf8');
  return {
    headers: {
      'x-github-event': 'pull_request',
      'x-github-delivery': deliveryId,
      'x-hub-signature-256': `sha256=${crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex')}`,
    },
    rawBody,
    webhookSecret: SECRET,
  };
}

function tempStores(t) {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-c8-streaming-'));
  t.after(() => fs.rmSync(rootPath, { recursive: true, force: true }));
  return {
    rootPath,
    c7Store: createGitHubAppBetaStore({ rootPath }),
    c8Store: createGitHubAppStreamingTrustStore({ rootPath }),
  };
}

function responseJson(value, ok = true) {
  return { ok, async json() { return value; } };
}

function makeGitHubFetch({
  files = [{ filename: 'docs/streaming.md', status: 'modified', additions: 3, deletions: 1 }],
  liveHeadSha = HEAD_SHA,
  checkRunId = 445566,
  checkFailure = null,
} = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });

    if (url === `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`) {
      return responseJson({
        token: 'ghs_streaming_test_token',
        expires_at: '2026-08-14T01:30:00.000Z',
      });
    }
    if (url === `https://api.github.com/repos/ali-ulu/huqan/pulls/${PR_NUMBER}`) {
      return responseJson({
        number: PR_NUMBER,
        base: { repo: { id: REPOSITORY_ID, full_name: REPOSITORY_FULL_NAME } },
        head: { sha: liveHeadSha },
      });
    }
    if (url.startsWith(`https://api.github.com/repos/ali-ulu/huqan/pulls/${PR_NUMBER}/files?`)) {
      const page = Number(new URL(url).searchParams.get('page'));
      const start = (page - 1) * 100;
      return responseJson(files.slice(start, start + 100));
    }
    if (url === 'https://api.github.com/repos/ali-ulu/huqan/check-runs') {
      if (checkFailure === 'throw') throw new Error('simulated network ambiguity');
      if (checkFailure === 'reject') return responseJson({ message: 'rejected' }, false);
      const body = JSON.parse(options.body);
      return responseJson({ id: checkRunId, head_sha: body.head_sha });
    }
    throw new Error(`unexpected GitHub URL: ${url}`);
  };
  return { fetchImpl, calls };
}

// A declined check is the one written without a receipt: title says so, and
// its external_id is namespaced apart from an evaluated verdict's.
function declinedCheckBodies(github) {
  return github.calls
    .filter(call => call.url.endsWith('/check-runs'))
    .map(call => JSON.parse(call.options.body))
    .filter(body => body.external_id.startsWith('huqan:c8:declined:'));
}

function privateKey() {
  return crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
}

async function run(t, fetchFixture, request = signedRequest(payload())) {
  const stores = tempStores(t);
  return {
    stores,
    result: await handleGitHubAppStreamingTrustWebhook({
      ...request,
      c7Store: stores.c7Store,
      c8Store: stores.c8Store,
      appId: '123456',
      privateKey: privateKey(),
      fetchImpl: fetchFixture.fetchImpl,
      nowMs: NOW_MS,
    }),
  };
}

test('authenticated PR event reaches exact-head code-change gate, chained receipt, and success check', async (t) => {
  const github = makeGitHubFetch();
  const { stores, result } = await run(t, github);

  assert.equal(result.observation.receipt.verdict, 'review');
  assert.equal(result.trust.receipt.verdict, 'allow');
  assert.equal(result.trust.receipt.decision, 'allow');
  assert.equal(result.trust.conclusion, 'success');
  assert.equal(result.trust.receipt.previousReceiptHash, result.observation.receipt.receiptHash);
  assert.equal(result.trust.receipt.metadata.c7ReceiptHash, result.observation.receipt.receiptHash);
  assert.equal(result.trust.receipt.metadata.repositoryId, REPOSITORY_ID);
  assert.equal(result.trust.receipt.metadata.repositoryFullName, REPOSITORY_FULL_NAME);
  assert.equal(result.trust.receipt.metadata.pullRequestNumber, PR_NUMBER);
  assert.equal(result.trust.receipt.metadata.headSha, HEAD_SHA);
  assert.equal(result.trust.receipt.metadata.fileCount, 1);
  assert.match(result.trust.receipt.metadata.evidenceSha256, /^[0-9a-f]{64}$/);
  assert.match(result.trust.receipt.receiptHash, /^[0-9a-f]{64}$/);

  const tokenCall = github.calls[0];
  assert.deepEqual(JSON.parse(tokenCall.options.body), {
    repository_ids: [REPOSITORY_ID],
    permissions: { checks: 'write', pull_requests: 'read' },
  });

  const checkCall = github.calls.find(call => call.url.endsWith('/check-runs'));
  const checkBody = JSON.parse(checkCall.options.body);
  assert.equal(checkBody.head_sha, HEAD_SHA);
  assert.equal(checkBody.status, 'completed');
  assert.equal(checkBody.conclusion, 'success');
  assert.match(checkBody.external_id, /^huqan:c8:[0-9a-f]{64}$/);
  assert.match(checkBody.output.summary, new RegExp(result.trust.receipt.receiptHash));

  const evaluation = stores.c8Store.readEvaluation(DELIVERY);
  assert.equal(evaluation.receipt.receiptHash, result.trust.receipt.receiptHash);
  const writeback = stores.c8Store.readWriteback(DELIVERY);
  assert.equal(writeback.state, 'complete');
  assert.equal(writeback.checkRunId, result.trust.checkRunId);
});

test('review, dry-run-only, and block verdicts update the review gate without inventing new verdicts', async (t) => {
  const cases = [
    {
      delivery: '92d3162e-cc78-11e3-81ab-4c9367dc0958',
      file: { filename: '.github/workflows/ci.yml', status: 'modified', additions: 2, deletions: 1 },
      verdict: 'review',
      conclusion: 'action_required',
    },
    {
      delivery: 'a2d3162e-cc78-11e3-81ab-4c9367dc0958',
      file: { filename: 'server.js', status: 'modified', additions: 2, deletions: 1 },
      verdict: 'dry_run_only',
      conclusion: 'action_required',
    },
    {
      delivery: 'b2d3162e-cc78-11e3-81ab-4c9367dc0958',
      file: { filename: 'scripts/release.js', status: 'modified', additions: 2, deletions: 1 },
      verdict: 'block',
      conclusion: 'failure',
    },
  ];

  for (const item of cases) {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-c8-verdict-'));
    t.after(() => fs.rmSync(rootPath, { recursive: true, force: true }));
    const github = makeGitHubFetch({ files: [item.file], checkRunId: 500000 + cases.indexOf(item) });
    const result = await handleGitHubAppStreamingTrustWebhook({
      ...signedRequest(payload(), item.delivery),
      c7Store: createGitHubAppBetaStore({ rootPath }),
      c8Store: createGitHubAppStreamingTrustStore({ rootPath }),
      appId: '123456',
      privateKey: privateKey(),
      fetchImpl: github.fetchImpl,
      nowMs: NOW_MS,
    });
    assert.equal(result.trust.receipt.verdict, item.verdict);
    assert.equal(result.trust.conclusion, item.conclusion);
    const checkBody = JSON.parse(github.calls.find(call => call.url.endsWith('/check-runs')).options.body);
    assert.equal(checkBody.conclusion, item.conclusion);
  }
});

test('same completed delivery replay returns stored C8 result without another token, PR read, file read, or check write', async (t) => {
  const stores = tempStores(t);
  const github = makeGitHubFetch();
  const request = signedRequest(payload());
  const key = privateKey();

  const first = await handleGitHubAppStreamingTrustWebhook({
    ...request,
    c7Store: stores.c7Store,
    c8Store: stores.c8Store,
    appId: '123456',
    privateKey: key,
    fetchImpl: github.fetchImpl,
    nowMs: NOW_MS,
  });
  const callCount = github.calls.length;
  const second = await handleGitHubAppStreamingTrustWebhook({
    ...request,
    c7Store: stores.c7Store,
    c8Store: stores.c8Store,
    appId: '123456',
    privateKey: key,
    fetchImpl: github.fetchImpl,
    nowMs: NOW_MS + 60000,
  });

  assert.equal(second.observation.duplicate, true);
  assert.equal(second.trust.duplicate, true);
  assert.equal(second.trust.receipt.receiptHash, first.trust.receipt.receiptHash);
  assert.equal(second.trust.checkRunId, first.trust.checkRunId);
  assert.equal(github.calls.length, callCount);
});

test('live PR head drift fails closed before changed-file retrieval, evaluation, or writeback', async (t) => {
  const stores = tempStores(t);
  const github = makeGitHubFetch({ liveHeadSha: 'c'.repeat(40) });
  await assert.rejects(
    () => handleGitHubAppStreamingTrustWebhook({
      ...signedRequest(payload()),
      c7Store: stores.c7Store,
      c8Store: stores.c8Store,
      appId: '123456',
      privateKey: privateKey(),
      fetchImpl: github.fetchImpl,
      nowMs: NOW_MS,
    }),
    (error) => error.code === ERROR_CODES.HEAD_DRIFT,
  );
  assert.equal(github.calls.filter(call => call.url.includes('/files?')).length, 0);
  assert.equal(stores.c8Store.readEvaluation(DELIVERY), null);
  assert.equal(stores.c8Store.readWriteback(DELIVERY).state, 'none');

  // Refusing is right; refusing invisibly is not. The pull request gets one
  // check saying so, and it is not a pass.
  const declined = declinedCheckBodies(github);
  assert.equal(declined.length, 1);
  assert.equal(declined[0].conclusion, 'action_required');
  assert.equal(declined[0].head_sha, HEAD_SHA);
  assert.equal(declined[0].output.title, 'HUQAN: declined');
  assert.match(declined[0].output.summary, new RegExp(ERROR_CODES.HEAD_DRIFT));
  assert.match(declined[0].output.summary, /No verdict and no receipt were produced, so this is not a pass\./);
});

test('changed-file evidence exceeding the file bound fails closed and never writes a check', async (t) => {
  const stores = tempStores(t);
  const files = Array.from({ length: MAX_FILES + 1 }, (_, index) => ({
    filename: `docs/file-${index}.md`,
    status: 'modified',
    additions: 1,
    deletions: 0,
  }));
  const github = makeGitHubFetch({ files });
  await assert.rejects(
    () => handleGitHubAppStreamingTrustWebhook({
      ...signedRequest(payload()),
      c7Store: stores.c7Store,
      c8Store: stores.c8Store,
      appId: '123456',
      privateKey: privateKey(),
      fetchImpl: github.fetchImpl,
      nowMs: NOW_MS,
    }),
    (error) => error.code === ERROR_CODES.EVIDENCE_TOO_LARGE,
  );
  assert.equal(stores.c8Store.readEvaluation(DELIVERY), null);
  assert.equal(stores.c8Store.readWriteback(DELIVERY).state, 'none');

  const declined = declinedCheckBodies(github);
  assert.equal(declined.length, 1);
  assert.equal(declined[0].conclusion, 'action_required');
  assert.match(declined[0].output.summary, new RegExp(ERROR_CODES.EVIDENCE_TOO_LARGE));
  assert.equal(declined[0].external_id.startsWith('huqan:c8:declined:'), true);
});

test('ambiguous check-run network outcome is durably marked and automatic replay refuses a second write', async (t) => {
  const stores = tempStores(t);
  const github = makeGitHubFetch({ checkFailure: 'throw' });
  const request = signedRequest(payload());
  const key = privateKey();

  await assert.rejects(
    () => handleGitHubAppStreamingTrustWebhook({
      ...request,
      c7Store: stores.c7Store,
      c8Store: stores.c8Store,
      appId: '123456',
      privateKey: key,
      fetchImpl: github.fetchImpl,
      nowMs: NOW_MS,
    }),
    (error) => error.code === ERROR_CODES.WRITEBACK_FAILED,
  );
  assert.equal(stores.c8Store.readWriteback(DELIVERY).state, 'started');
  const callsAfterAmbiguousWrite = github.calls.length;

  await assert.rejects(
    () => handleGitHubAppStreamingTrustWebhook({
      ...request,
      c7Store: stores.c7Store,
      c8Store: stores.c8Store,
      appId: '123456',
      privateKey: key,
      fetchImpl: github.fetchImpl,
      nowMs: NOW_MS + 60000,
    }),
    (error) => error.code === ERROR_CODES.WRITEBACK_STATE_UNKNOWN,
  );
  assert.equal(github.calls.length, callsAfterAmbiguousWrite);
  assert.equal(github.calls.filter(call => call.url.endsWith('/check-runs')).length, 1);
  // The writeback stage is deliberately outside the declined-check path: there,
  // writing a check is exactly what failed, and refusing the second write is
  // the behaviour under test.
  assert.deepEqual(declinedCheckBodies(github), []);
});

test('C8 receipt, durable store, and check output exclude webhook title/body/sender and patch bodies', async (t) => {
  const github = makeGitHubFetch({
    files: [{
      filename: 'docs/safe.md',
      status: 'modified',
      additions: 1,
      deletions: 0,
      patch: 'private-patch-body-must-not-survive',
    }],
  });
  const { stores, result } = await run(t, github);
  const disk = fs.readFileSync(
    path.join(stores.rootPath, 'streaming-trust', 'evaluations', `${DELIVERY}.json`),
    'utf8',
  );
  const checkBody = github.calls.find(call => call.url.endsWith('/check-runs')).options.body;
  const serialized = JSON.stringify(result.trust.receipt);
  for (const secret of [
    'private-title-must-not-survive',
    'private-body-token-must-not-survive',
    'private-feature-name',
    'private-user',
    'private@example.invalid',
    'private-patch-body-must-not-survive',
  ]) {
    assert.equal(disk.includes(secret), false);
    assert.equal(checkBody.includes(secret), false);
    assert.equal(serialized.includes(secret), false);
  }
});

test('unknown code-change source decision fails closed in the canonical verdict owner', () => {
  assert.throws(
    () => toCanonicalVerdict('code_change', 'attacker_allowish_value'),
    (error) => error.code === 'UNKNOWN_VERDICT_SOURCE',
  );
});

// --- a refusal has to be visible on the pull request, not only to the caller ---
//
// Every bound in this loop is fail-closed and stays that way. What changed is
// that refusing no longer writes nothing: an absent check on a pull request
// reads as a check with nothing to say, which is the shape #681 was about.

test('an unexpected failure before a verdict still declines visibly, under a generic code', async (t) => {
  const stores = tempStores(t);
  const github = makeGitHubFetch();
  const brokenStore = {
    ...stores.c8Store,
    commitEvaluation() { throw new Error('storage went sideways'); },
  };

  await assert.rejects(
    () => handleGitHubAppStreamingTrustWebhook({
      ...signedRequest(payload()),
      c7Store: stores.c7Store,
      c8Store: brokenStore,
      appId: '123456',
      privateKey: privateKey(),
      fetchImpl: github.fetchImpl,
      nowMs: NOW_MS,
    }),
    // The original cause reaches the caller unchanged; the check is additional.
    (error) => error.message === 'storage went sideways',
  );

  const declined = declinedCheckBodies(github);
  assert.equal(declined.length, 1);
  assert.equal(declined[0].conclusion, 'action_required');
  assert.match(declined[0].output.summary, new RegExp(DECLINED_FALLBACK_CODE));
  // An error this module did not raise must not have its message forwarded to
  // GitHub -- only the fixed reason for its code.
  assert.equal(declined[0].output.summary.includes('storage went sideways'), false);
});

test('a declined check that cannot be written does not mask the failure it was reporting', async (t) => {
  const stores = tempStores(t);
  const github = makeGitHubFetch({ liveHeadSha: 'c'.repeat(40), checkFailure: 'throw' });

  await assert.rejects(
    () => handleGitHubAppStreamingTrustWebhook({
      ...signedRequest(payload()),
      c7Store: stores.c7Store,
      c8Store: stores.c8Store,
      appId: '123456',
      privateKey: privateKey(),
      fetchImpl: github.fetchImpl,
      nowMs: NOW_MS,
    }),
    // Not the reporting failure: the head drift is the thing worth reading.
    (error) => error.code === ERROR_CODES.HEAD_DRIFT,
  );
  assert.equal(github.calls.filter(call => call.url.endsWith('/check-runs')).length, 1);
  assert.equal(stores.c8Store.readEvaluation(DELIVERY), null);
});

test('a declined check carries nothing from the webhook payload', async (t) => {
  const stores = tempStores(t);
  const github = makeGitHubFetch({ liveHeadSha: 'c'.repeat(40) });

  await assert.rejects(
    () => handleGitHubAppStreamingTrustWebhook({
      ...signedRequest(payload()),
      c7Store: stores.c7Store,
      c8Store: stores.c8Store,
      appId: '123456',
      privateKey: privateKey(),
      fetchImpl: github.fetchImpl,
      nowMs: NOW_MS,
    }),
    (error) => error.code === ERROR_CODES.HEAD_DRIFT,
  );

  const body = github.calls.find(call => call.url.endsWith('/check-runs')).options.body;
  for (const secret of [
    'private-title-must-not-survive',
    'private-body-token-must-not-survive',
    'private-feature-name',
    'private-user',
    'private@example.invalid',
  ]) {
    assert.equal(body.includes(secret), false);
  }
});

test('a transient read failure is declined but not remembered, so a redelivery can still evaluate', async (t) => {
  const stores = tempStores(t);
  let filesAttempts = 0;
  const github = makeGitHubFetch();
  const flaky = async (url, options) => {
    if (url.includes('/files?')) {
      filesAttempts += 1;
      if (filesAttempts === 1) throw new Error('transient network failure');
    }
    return github.fetchImpl(url, options);
  };
  const request = signedRequest(payload());
  const key = privateKey();
  const call = (nowMs, fetchImpl) => handleGitHubAppStreamingTrustWebhook({
    ...request,
    c7Store: stores.c7Store,
    c8Store: stores.c8Store,
    appId: '123456',
    privateKey: key,
    fetchImpl,
    nowMs,
  });

  await assert.rejects(() => call(NOW_MS, flaky), (error) => error.code === ERROR_CODES.FILES_READ_FAILED);
  assert.equal(declinedCheckBodies(github).length, 1);
  assert.equal(stores.c8Store.readEvaluation(DELIVERY), null);

  // Persisting the decline would have frozen this delivery on its worst moment.
  const second = await call(NOW_MS + 60000, flaky);
  assert.equal(second.trust.receipt.verdict, 'allow');
  assert.equal(second.trust.conclusion, 'success');
  assert.equal(stores.c8Store.readWriteback(DELIVERY).state, 'complete');
});
