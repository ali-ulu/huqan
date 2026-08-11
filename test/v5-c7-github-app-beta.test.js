'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createGitHubAppBetaStore } = require('../lib/github-app-beta-store');
const {
  ERROR_CODES,
  handleGitHubAppPullRequestWebhook,
} = require('../lib/github-app-beta-handler');

const SECRET = 'webhook-secret-for-test';
const DELIVERY = '72d3162e-cc78-11e3-81ab-4c9367dc0958';

function payload(overrides = {}) {
  return {
    action: 'opened',
    number: 279,
    installation: { id: 991 },
    repository: { id: 1300995136, full_name: 'ali-ulu/huqan', private: false },
    pull_request: {
      number: 279,
      title: 'sensitive title that must not be persisted',
      body: 'secret-token-value-that-must-not-be-persisted',
      head: { sha: 'a'.repeat(40), ref: 'feature/private-name' },
    },
    sender: { login: 'private-user-name', email: 'private@example.invalid' },
    ...overrides,
  };
}

function signedRequest(bodyObject, overrides = {}) {
  const { headers: headerOverrides = {}, ...restOverrides } = overrides;
  const rawBody = Buffer.from(JSON.stringify(bodyObject), 'utf8');
  const signature = `sha256=${crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex')}`;
  return {
    headers: {
      'x-github-event': 'pull_request',
      'x-github-delivery': DELIVERY,
      'x-hub-signature-256': signature,
      ...headerOverrides,
    },
    rawBody,
    webhookSecret: SECRET,
    ...restOverrides,
  };
}

function tempStore(t) {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-github-app-handler-'));
  t.after(() => fs.rmSync(rootPath, { recursive: true, force: true }));
  return { rootPath, store: createGitHubAppBetaStore({ rootPath }) };
}

test('valid pull_request delivery binds immutable source identity and emits a bounded review receipt', (t) => {
  const { rootPath, store } = tempStore(t);
  const request = signedRequest(payload());
  const result = handleGitHubAppPullRequestWebhook({
    ...request,
    store,
    nowMs: Date.parse('2026-08-11T14:30:00.000Z'),
  });
  assert.equal(result.duplicate, false);
  assert.equal(result.receipt.schemaVersion, 'v4-receipt-v1');
  assert.equal(result.receipt.receiptKind, 'github_app_beta_pull_request_observation');
  assert.equal(result.receipt.workspaceId, 'default');
  assert.equal(result.receipt.actor, 'github-app:991');
  assert.equal(result.receipt.verdict, 'review');
  assert.equal(result.receipt.decision, 'beta_observation_only');
  assert.equal(result.receipt.metadata.repositoryId, 1300995136);
  assert.equal(result.receipt.metadata.repositoryFullName, 'ali-ulu/huqan');
  assert.equal(result.receipt.metadata.pullRequestNumber, 279);
  assert.equal(result.receipt.metadata.headSha, 'a'.repeat(40));
  assert.equal(result.receipt.previousReceiptHash, 'genesis:v4-receipt-chain');
  assert.match(result.receipt.receiptHash, /^[0-9a-f]{64}$/);
  const disk = fs.readFileSync(path.join(rootPath, 'receipts', `${DELIVERY}.json`), 'utf8');
  assert.doesNotMatch(disk, /secret-token|private-user-name|private@example|feature\/private-name|sensitive title/);
});

test('signature verification happens before JSON parsing or durable mutation', (t) => {
  const { rootPath, store } = tempStore(t);
  const rawBody = Buffer.from('{not-json', 'utf8');
  assert.throws(
    () => handleGitHubAppPullRequestWebhook({
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': DELIVERY,
        'x-hub-signature-256': `sha256=${'0'.repeat(64)}`,
      },
      rawBody,
      webhookSecret: SECRET,
      store,
    }),
    (error) => error.code === ERROR_CODES.INVALID_SIGNATURE,
  );
  assert.equal(fs.readdirSync(path.join(rootPath, 'reservations')).length, 0);
  assert.equal(fs.readdirSync(path.join(rootPath, 'receipts')).length, 0);
});

test('unsupported event/action and inconsistent PR identity fail before persistence', (t) => {
  const { rootPath, store } = tempStore(t);
  const eventRequest = signedRequest(payload(), { headers: { 'x-github-event': 'issues' } });
  assert.throws(
    () => handleGitHubAppPullRequestWebhook({ ...eventRequest, store }),
    (error) => error.code === ERROR_CODES.UNSUPPORTED_EVENT,
  );
  const actionRequest = signedRequest(payload({ action: 'closed' }));
  assert.throws(
    () => handleGitHubAppPullRequestWebhook({ ...actionRequest, store }),
    (error) => error.code === ERROR_CODES.UNSUPPORTED_ACTION,
  );
  const mismatchRequest = signedRequest(payload({ pull_request: { ...payload().pull_request, number: 280 } }));
  assert.throws(
    () => handleGitHubAppPullRequestWebhook({ ...mismatchRequest, store }),
    (error) => error.code === ERROR_CODES.INVALID_PAYLOAD,
  );
  assert.equal(fs.readdirSync(path.join(rootPath, 'reservations')).length, 0);
});

test('duplicate security headers and invalid UTF-8 fail closed before persistence', (t) => {
  const { rootPath, store } = tempStore(t);
  const request = signedRequest(payload());
  assert.throws(
    () => handleGitHubAppPullRequestWebhook({
      ...request,
      headers: {
        ...request.headers,
        'X-GitHub-Delivery': DELIVERY,
      },
      store,
    }),
    (error) => error.code === ERROR_CODES.INVALID_HEADERS,
  );

  const invalidUtf8 = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]);
  const signature = `sha256=${crypto.createHmac('sha256', SECRET).update(invalidUtf8).digest('hex')}`;
  assert.throws(
    () => handleGitHubAppPullRequestWebhook({
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': DELIVERY,
        'x-hub-signature-256': signature,
      },
      rawBody: invalidUtf8,
      webhookSecret: SECRET,
      store,
    }),
    (error) => error.code === ERROR_CODES.INVALID_JSON,
  );
  assert.equal(fs.readdirSync(path.join(rootPath, 'reservations')).length, 0);
});

test('same successful GitHub redelivery GUID returns the stored receipt without a second receipt', (t) => {
  const { rootPath, store } = tempStore(t);
  const request = signedRequest(payload());
  const first = handleGitHubAppPullRequestWebhook({ ...request, store, nowMs: Date.parse('2026-08-11T14:30:00.000Z') });
  const second = handleGitHubAppPullRequestWebhook({ ...request, store, nowMs: Date.parse('2026-08-11T14:31:00.000Z') });
  assert.equal(second.duplicate, true);
  assert.deepEqual(second.receipt, first.receipt);
  assert.equal(fs.readdirSync(path.join(rootPath, 'receipts')).length, 1);
});

test('replay mutant: same delivery GUID with different authenticated body fails closed', (t) => {
  const { store } = tempStore(t);
  const first = signedRequest(payload());
  handleGitHubAppPullRequestWebhook({ ...first, store, nowMs: Date.parse('2026-08-11T14:30:00.000Z') });
  const mutated = signedRequest(payload({ action: 'synchronize' }));
  assert.throws(
    () => handleGitHubAppPullRequestWebhook({ ...mutated, store, nowMs: Date.parse('2026-08-11T14:31:00.000Z') }),
    (error) => error.code === 'GITHUB_APP_DELIVERY_CONFLICT',
  );
});

test('crash-window reservation without receipt blocks redelivery rather than double-processing', (t) => {
  const { store } = tempStore(t);
  const request = signedRequest(payload());
  const bodyHash = crypto.createHash('sha256').update(request.rawBody).digest('hex');
  store.reserveDelivery({
    deliveryId: DELIVERY,
    event: 'pull_request',
    repositoryId: 1300995136,
    repositoryFullName: 'ali-ulu/huqan',
    installationId: 991,
    pullRequestNumber: 279,
    headSha: 'a'.repeat(40),
    payloadSha256: bodyHash,
    reservedAt: '2026-08-11T14:29:00.000Z',
  });
  assert.throws(
    () => handleGitHubAppPullRequestWebhook({ ...request, store, nowMs: Date.parse('2026-08-11T14:30:00.000Z') }),
    (error) => error.code === ERROR_CODES.DELIVERY_STATE_UNKNOWN,
  );
});
