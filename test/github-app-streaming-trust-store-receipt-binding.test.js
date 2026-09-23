'use strict';

/**
 * The Streaming Trust store must refuse a receipt that belongs to a different
 * delivery. Every mismatched receipt below is re-hashed, so it carries a
 * valid canonical hash: the refusal has to come from the binding comparison
 * itself, not from the hash check that would otherwise mask it.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createGitHubAppStreamingTrustStore } = require('../lib/github-app-streaming-trust-store');
const { hashCanonicalReceiptPayload } = require('../lib/receipt/canonical-receipt');

const INVALID_RECEIPT = 'GITHUB_APP_STREAMING_STORE_INVALID_RECEIPT';

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

function receiptFor(binding, overrides = {}) {
  const { metadata: metadataOverrides, ...top } = overrides;
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
      ...metadataOverrides,
    },
    ...top,
  });
}

function freshStore(t) {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-streaming-store-'));
  t.after(() => fs.rmSync(rootPath, { recursive: true, force: true }));
  return { rootPath, store: createGitHubAppStreamingTrustStore({ rootPath }) };
}

function assertRefused(store, receipt) {
  assert.throws(() => store.commitEvaluation(BINDING, receipt), (error) => error.code === INVALID_RECEIPT);
  assert.equal(store.readEvaluation(BINDING.deliveryId), null, 'a refused receipt must not be stored');
}

test('a receipt sealed for its own delivery is committed and read back', (t) => {
  const { store } = freshStore(t);
  const receipt = receiptFor(BINDING);

  const committed = store.commitEvaluation(BINDING, receipt);

  assert.equal(committed.duplicate, false);
  assert.deepEqual(store.readEvaluation(BINDING.deliveryId).receipt, receipt);
});

const MISMATCHES = [
  ['chained to a different C7 receipt', { previousReceiptHash: 'c'.repeat(64) }],
  ['metadata for another delivery', { metadata: { deliveryId: '00000000-0000-4000-8000-000000000000' } }],
  ['metadata for another repository id', { metadata: { repositoryId: 999 } }],
  ['metadata for another repository name', { metadata: { repositoryFullName: 'acme/other' } }],
  ['metadata for another installation', { metadata: { installationId: 999 } }],
  ['metadata for another pull request', { metadata: { pullRequestNumber: 8 } }],
  ['metadata for another head commit', { metadata: { headSha: 'f'.repeat(40) } }],
  ['metadata naming another C7 receipt', { metadata: { c7ReceiptHash: 'd'.repeat(64) } }],
];

for (const [label, overrides] of MISMATCHES) {
  test(`a correctly hashed receipt with ${label} is refused`, (t) => {
    const { store } = freshStore(t);
    assertRefused(store, receiptFor(BINDING, overrides));
  });
}

for (const metadata of [null, 'not-an-object']) {
  test(`a correctly hashed receipt with metadata ${JSON.stringify(metadata)} is refused, not crashed on`, (t) => {
    const { store } = freshStore(t);
    const { metadata: _dropped, receiptHash: _stale, ...payload } = receiptFor(BINDING);
    assertRefused(store, sealed({ ...payload, metadata }));
  });
}

test('a receipt whose hash does not cover its content is refused', (t) => {
  const { store } = freshStore(t);
  const tampered = { ...receiptFor(BINDING), decision: 'block' };
  assertRefused(store, tampered);
});

test('a stored evaluation whose receipt was swapped on disk is refused on read', (t) => {
  const { rootPath, store } = freshStore(t);
  store.commitEvaluation(BINDING, receiptFor(BINDING));
  const file = path.join(rootPath, 'streaming-trust', 'evaluations', `${BINDING.deliveryId}.json`);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  record.receipt = receiptFor(BINDING, { metadata: { pullRequestNumber: 8 } });
  fs.writeFileSync(file, JSON.stringify(record));

  assert.throws(() => store.readEvaluation(BINDING.deliveryId), (error) => error.code === INVALID_RECEIPT);
});
