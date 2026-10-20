'use strict';

/**
 * #4087 PR-3: the store half of the public receipt publication. The C8 loop
 * hands the store a receipt it just signed; the store files it beside the
 * evaluation it discloses and refuses anything that does not line up with a
 * delivery the loop has already decided.
 *
 * Every refusal below is driven through the store's public surface, so the
 * guard has to hold on the way in (commit) and on the way back out (read),
 * not only in the snapshot helper.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createGitHubAppStreamingTrustStore } = require('../lib/github-app-streaming-trust-store');
const { hashCanonicalReceiptPayload } = require('../lib/receipt/canonical-receipt');

const INVALID_RECEIPT = 'GITHUB_APP_STREAMING_STORE_INVALID_RECEIPT';
const DELIVERY_CONFLICT = 'GITHUB_APP_STREAMING_STORE_DELIVERY_CONFLICT';

const BINDING = Object.freeze({
  deliveryId: '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b',
  repositoryId: 101,
  repositoryFullName: 'acme/widgets',
  installationId: 202,
  pullRequestNumber: 7,
  headSha: 'a'.repeat(40),
  c7ReceiptHash: 'b'.repeat(64),
});

function sealed(payload) {
  return { ...payload, receiptHash: hashCanonicalReceiptPayload(payload) };
}

function receiptFor(binding) {
  return sealed({
    receiptId: 'rcpt-streaming-1',
    decision: 'allow',
    previousReceiptHash: binding.c7ReceiptHash,
    metadata: {
      deliveryId: binding.deliveryId,
      repositoryId: binding.repositoryId,
      repositoryFullName: binding.repositoryFullName,
      installationId: binding.installationId,
      pullRequestNumber: binding.pullRequestNumber,
      headSha: binding.headSha,
      c7ReceiptHash: binding.c7ReceiptHash,
    },
  });
}

function publicReceiptFor(receiptHash, overrides = {}) {
  return {
    schemaVersion: 'v5-public-trust-receipt-v1',
    publicReceiptId: 'c'.repeat(64),
    binding: { internalReceiptHash: receiptHash },
    integrity: { checksum: 'd'.repeat(64) },
    ...overrides,
  };
}

function decidedStore(t) {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-streaming-public-'));
  t.after(() => fs.rmSync(rootPath, { recursive: true, force: true }));
  const store = createGitHubAppStreamingTrustStore({ rootPath });
  const receipt = receiptFor(BINDING);
  store.commitEvaluation(BINDING, receipt);
  return { rootPath, store, receipt };
}

test('a public receipt for a decided delivery is committed and read back', (t) => {
  const { store, receipt } = decidedStore(t);
  const publicReceipt = publicReceiptFor(receipt.receiptHash);

  const committed = store.commitPublicReceipt(BINDING, receipt.receiptHash, publicReceipt);

  assert.equal(committed.publicReceiptId, publicReceipt.publicReceiptId);
  assert.equal(committed.checksum, publicReceipt.integrity.checksum);
  assert.deepEqual(committed.publicReceipt, publicReceipt);
  assert.deepEqual(store.readPublicReceipt(BINDING.deliveryId).publicReceipt, publicReceipt);
});

test('an absent public receipt reads back as null, not as a failure', (t) => {
  const { store } = decidedStore(t);
  assert.equal(store.readPublicReceipt(BINDING.deliveryId), null);
});

test('a public receipt with no matching evaluation is refused', (t) => {
  const { store, receipt } = decidedStore(t);
  const other = { ...BINDING, deliveryId: '00000000-0000-4000-8000-000000000000' };

  assert.throws(
    () => store.commitPublicReceipt(other, receipt.receiptHash, publicReceiptFor(receipt.receiptHash)),
    (error) => error.code === DELIVERY_CONFLICT,
  );
  assert.equal(store.readPublicReceipt(other.deliveryId), null, 'a refused receipt must not be stored');
});

test('a public receipt whose hash disagrees with the evaluation is refused', (t) => {
  const { store } = decidedStore(t);
  const foreignHash = 'e'.repeat(64);

  assert.throws(
    () => store.commitPublicReceipt(BINDING, foreignHash, publicReceiptFor(foreignHash)),
    (error) => error.code === DELIVERY_CONFLICT,
  );
});

const MALFORMED = [
  ['a receipt hash that is not a hash', 'not-a-hash', {}],
  ['a non-string public receipt id', null, { publicReceiptId: 42 }],
  ['a public receipt id that is not a hash', null, { publicReceiptId: 'nope' }],
  ['a missing checksum', null, { integrity: {} }],
  ['a checksum that is not a hash', null, { integrity: { checksum: 'nope' } }],
];

for (const [label, hashOverride, overrides] of MALFORMED) {
  test(`a public receipt with ${label} is refused`, (t) => {
    const { store, receipt } = decidedStore(t);
    const hash = hashOverride ?? receipt.receiptHash;
    assert.throws(
      () => store.commitPublicReceipt(BINDING, hash, publicReceiptFor(receipt.receiptHash, overrides)),
      (error) => error.code === INVALID_RECEIPT,
    );
  });
}

test('a public receipt that is not an object is refused', (t) => {
  const { store, receipt } = decidedStore(t);

  assert.throws(
    () => store.commitPublicReceipt(BINDING, receipt.receiptHash, null),
    (error) => error.code === INVALID_RECEIPT,
  );
});

test('a public receipt whose integrity is not an object is refused', (t) => {
  const { store, receipt } = decidedStore(t);
  const malformed = { ...publicReceiptFor(receipt.receiptHash), integrity: 'not-an-object' };

  assert.throws(
    () => store.commitPublicReceipt(BINDING, receipt.receiptHash, malformed),
    (error) => error.code === INVALID_RECEIPT,
  );
});

test('re-committing the same public receipt returns the stored record untouched', (t) => {
  const { store, receipt } = decidedStore(t);
  const publicReceipt = publicReceiptFor(receipt.receiptHash);

  const first = store.commitPublicReceipt(BINDING, receipt.receiptHash, publicReceipt);
  const second = store.commitPublicReceipt(BINDING, receipt.receiptHash, publicReceipt);

  assert.equal(second.publicReceiptId, first.publicReceiptId);
  assert.deepEqual(second.publicReceipt, publicReceipt);
});

test('a delivery that already holds a different public receipt is refused', (t) => {
  const { store, receipt } = decidedStore(t);
  store.commitPublicReceipt(BINDING, receipt.receiptHash, publicReceiptFor(receipt.receiptHash));

  assert.throws(
    () => store.commitPublicReceipt(BINDING, receipt.receiptHash, publicReceiptFor(receipt.receiptHash, { publicReceiptId: 'f'.repeat(64) })),
    (error) => error.code === DELIVERY_CONFLICT,
  );
});

test('a stored public receipt swapped on disk is refused on read', (t) => {
  const { rootPath, store, receipt } = decidedStore(t);
  store.commitPublicReceipt(BINDING, receipt.receiptHash, publicReceiptFor(receipt.receiptHash));
  const file = path.join(rootPath, 'streaming-trust', 'public-receipts', `${BINDING.deliveryId}.json`);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  record.publicReceipt.binding.internalReceiptHash = 'a'.repeat(64);
  fs.writeFileSync(file, JSON.stringify(record));

  assert.throws(() => store.readPublicReceipt(BINDING.deliveryId), (error) => error.code === INVALID_RECEIPT);
});

test('a stored public receipt whose binding is not an object is refused on read', (t) => {
  const { rootPath, store, receipt } = decidedStore(t);
  store.commitPublicReceipt(BINDING, receipt.receiptHash, publicReceiptFor(receipt.receiptHash));
  const file = path.join(rootPath, 'streaming-trust', 'public-receipts', `${BINDING.deliveryId}.json`);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  record.publicReceipt.binding = null;
  fs.writeFileSync(file, JSON.stringify(record));

  assert.throws(() => store.readPublicReceipt(BINDING.deliveryId), (error) => error.code === INVALID_RECEIPT);
});

test('a stored public receipt carrying an unexpected key is refused on read', (t) => {
  const { rootPath, store, receipt } = decidedStore(t);
  store.commitPublicReceipt(BINDING, receipt.receiptHash, publicReceiptFor(receipt.receiptHash));
  const file = path.join(rootPath, 'streaming-trust', 'public-receipts', `${BINDING.deliveryId}.json`);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  record.unexpected = true;
  fs.writeFileSync(file, JSON.stringify(record));

  assert.throws(() => store.readPublicReceipt(BINDING.deliveryId), (error) => error.code === INVALID_RECEIPT);
});
