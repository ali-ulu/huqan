'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ERROR_CODES,
  createGitHubAppBetaStore,
} = require('../lib/github-app-beta-store');
const { buildCanonicalReceiptPayload } = require('../lib/receipt/canonical-receipt');
const { appendReceiptToChain } = require('../lib/receipt/receipt-chain');

const DELIVERY = '72d3162e-cc78-11e3-81ab-4c9367dc0958';

function binding(overrides = {}) {
  return {
    deliveryId: DELIVERY,
    event: 'pull_request',
    repositoryId: 1300995136,
    repositoryFullName: 'ali-ulu/huqan',
    installationId: 99,
    pullRequestNumber: 279,
    headSha: 'a'.repeat(40),
    payloadSha256: 'b'.repeat(64),
    reservedAt: '2026-08-11T14:30:00.000Z',
    ...overrides,
  };
}

function receipt(input = binding()) {
  const canonicalPayload = buildCanonicalReceiptPayload({
    receiptId: `github_app_beta_test_${input.deliveryId}`,
    receiptKind: 'github_app_beta_pull_request_observation',
    decision: 'beta_observation_only',
    status: 'observed',
    admissionId: `github_app_delivery:${input.deliveryId}`,
    workspaceId: 'default',
    actor: `github-app:${input.installationId}`,
    agentId: `github-app:${input.installationId}`,
    provenanceId: `github-app-delivery:${input.deliveryId}`,
    trustPolicyVersion: 'v5-c7-github-app-beta-v1',
    approvalStatus: 'pending',
    reason: 'github_app_beta_observation_requires_review',
    createdAt: input.reservedAt,
    metadata: {
      deliveryId: input.deliveryId.toLowerCase(),
      event: input.event,
      action: 'opened',
      repositoryId: input.repositoryId,
      repositoryFullName: input.repositoryFullName,
      installationId: input.installationId,
      pullRequestNumber: input.pullRequestNumber,
      headSha: input.headSha,
      payloadSha256: input.payloadSha256,
    },
  }, { verdict: 'review' });
  return appendReceiptToChain(canonicalPayload);
}

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-github-app-beta-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('reservation and receipt survive store restart and redelivery is idempotent', (t) => {
  const rootPath = tempRoot(t);
  const input = binding();
  const first = createGitHubAppBetaStore({ rootPath });
  assert.equal(first.reserveDelivery(input).state, 'reserved');
  const committed = receipt(input);
  first.commitReceipt(input, committed);

  const restarted = createGitHubAppBetaStore({ rootPath });
  const duplicate = restarted.reserveDelivery({ ...input, reservedAt: '2026-08-11T14:31:00.000Z' });
  assert.equal(duplicate.state, 'complete');
  assert.equal(duplicate.receipt.receiptHash, committed.receiptHash);
});

test('same delivery GUID with mutated payload is rejected before any second receipt', (t) => {
  const rootPath = tempRoot(t);
  const store = createGitHubAppBetaStore({ rootPath });
  const input = binding();
  store.reserveDelivery(input);
  store.commitReceipt(input, receipt(input));
  assert.throws(
    () => store.reserveDelivery({ ...input, payloadSha256: 'd'.repeat(64), reservedAt: '2026-08-11T14:31:00.000Z' }),
    (error) => error.code === ERROR_CODES.DELIVERY_CONFLICT,
  );
});

test('crash window remains fail-closed: a durable reservation without receipt is pending', (t) => {
  const rootPath = tempRoot(t);
  const input = binding();
  const first = createGitHubAppBetaStore({ rootPath });
  assert.equal(first.reserveDelivery(input).state, 'reserved');
  const restarted = createGitHubAppBetaStore({ rootPath });
  const second = restarted.reserveDelivery({ ...input, reservedAt: '2026-08-11T14:31:00.000Z' });
  assert.equal(second.state, 'pending');
  assert.equal(second.receipt, null);
});

test('stored receipt tampering is rejected on read', (t) => {
  const rootPath = tempRoot(t);
  const input = binding();
  const store = createGitHubAppBetaStore({ rootPath });
  store.reserveDelivery(input);
  store.commitReceipt(input, receipt(input));
  const receiptPath = path.join(rootPath, 'receipts', `${DELIVERY}.json`);
  const record = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  record.receipt.metadata.headSha = 'd'.repeat(40);
  fs.writeFileSync(receiptPath, `${JSON.stringify(record)}\n`, 'utf8');
  assert.throws(
    () => store.readReceipt(DELIVERY),
    (error) => error.code === ERROR_CODES.INVALID_RECEIPT,
  );
});

test('pre-existing symbolic-link reservation directory is rejected', (t) => {
  const rootPath = tempRoot(t);
  const target = tempRoot(t);
  fs.symlinkSync(target, path.join(rootPath, 'reservations'), 'dir');
  assert.throws(
    () => createGitHubAppBetaStore({ rootPath }),
    (error) => error.code === ERROR_CODES.UNSAFE_ROOT,
  );
});

test('delivery ID path traversal and symbolic-link roots fail closed', (t) => {
  const rootPath = tempRoot(t);
  const store = createGitHubAppBetaStore({ rootPath });
  assert.throws(
    () => store.reserveDelivery(binding({ deliveryId: '../../escape' })),
    (error) => error.code === ERROR_CODES.INVALID_BINDING,
  );

  const target = tempRoot(t);
  const link = path.join(os.tmpdir(), `huqan-github-app-link-${process.pid}-${Date.now()}`);
  fs.symlinkSync(target, link, 'dir');
  t.after(() => fs.rmSync(link, { force: true }));
  assert.throws(
    () => createGitHubAppBetaStore({ rootPath: link }),
    (error) => error.code === ERROR_CODES.UNSAFE_ROOT,
  );
});
