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
  return {
    schemaVersion: 'v5-github-app-beta-receipt-v1',
    deliveryId: input.deliveryId.toLowerCase(),
    payloadSha256: input.payloadSha256,
    receiptHash: 'c'.repeat(64),
  };
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
  first.commitReceipt(input, receipt(input));

  const restarted = createGitHubAppBetaStore({ rootPath });
  const duplicate = restarted.reserveDelivery({ ...input, reservedAt: '2026-08-11T14:31:00.000Z' });
  assert.equal(duplicate.state, 'complete');
  assert.equal(duplicate.receipt.receiptHash, 'c'.repeat(64));
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
