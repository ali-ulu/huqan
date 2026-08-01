'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildImmutableExternalSourceSnapshot,
  sha256,
} = require('../lib/ingest');
const {
  buildExternalIngestApprovalEnvelope,
} = require('../lib/external-ingest-approval');

const COMMIT_SHA = 'a'.repeat(40);
const BLOB_SHA = 'b'.repeat(40);

function githubSnapshot() {
  const built = buildImmutableExternalSourceSnapshot({
    sourceType: 'github',
    repoUrl: 'https://github.com/ali-ulu/huqan',
    commitSha: COMMIT_SHA,
    files: [{ path: 'README.md', content: '# HUQAN', blobSha: BLOB_SHA }],
  });
  assert.equal(built.ok, true);
  return built.snapshot;
}

test('raw external approval data stays fail-closed without an immutable snapshot', () => {
  const result = buildExternalIngestApprovalEnvelope({
    sourceType: 'github',
    repoUrl: 'https://github.com/ali-ulu/huqan',
    branch: 'main',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'INGEST_SNAPSHOT_REQUIRED');
  assert.equal(result.payload, undefined);
  assert.equal(result.snapshotHash, undefined);
});

test('approval envelope is bound to verified reviewed bytes and immutable identity', () => {
  const snapshot = githubSnapshot();
  const first = buildExternalIngestApprovalEnvelope({
    sourceType: 'repo',
    externalSourceSnapshot: snapshot,
  });
  const second = buildExternalIngestApprovalEnvelope({
    sourceType: 'github',
    snapshot: structuredClone(snapshot),
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.sourceType, 'github');
  assert.equal(first.sourceRef, snapshot.sourceRef);
  assert.equal(first.immutableSourceId, COMMIT_SHA);
  assert.equal(first.manifestHash, snapshot.manifestHash);
  assert.equal(first.snapshotHash, second.snapshotHash);
  assert.equal(first.idempotencyKey, second.idempotencyKey);
  assert.deepEqual(first.payload.externalSourceSnapshot, snapshot);
  assert.equal(first.payload.sourceRef.includes('main'), false);
  assert.equal(first.snapshotHash, sha256(first.payload));
});

test('approval envelope rejects source type mismatch and snapshot tampering', () => {
  const snapshot = githubSnapshot();

  const wrongType = buildExternalIngestApprovalEnvelope({
    sourceType: 'markdown',
    externalSourceSnapshot: snapshot,
  });
  assert.equal(wrongType.ok, false);
  assert.equal(wrongType.code, 'SOURCE_SNAPSHOT_TYPE_MISMATCH');

  const tampered = structuredClone(snapshot);
  tampered.files[0].content = '# attacker content';
  const tamperVerdict = buildExternalIngestApprovalEnvelope({
    sourceType: 'github',
    externalSourceSnapshot: tampered,
  });
  assert.equal(tamperVerdict.ok, false);
  assert.equal(tamperVerdict.code, 'SOURCE_SNAPSHOT_CONTENT_HASH_MISMATCH');
});

test('unknown snapshot fields cannot smuggle credentials into the approval envelope', () => {
  const snapshot = githubSnapshot();
  snapshot.token = 'ghp_secret';

  const result = buildExternalIngestApprovalEnvelope({
    externalSourceSnapshot: snapshot,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'SOURCE_SNAPSHOT_FIELD_UNSUPPORTED');
  assert.equal(result.payload, undefined);
});

test('explicit idempotency key is preserved but remains snapshot-bound by snapshotHash', () => {
  const snapshot = githubSnapshot();
  const result = buildExternalIngestApprovalEnvelope({
    externalSourceSnapshot: snapshot,
    idempotencyKey: 'customer-request-42',
  });

  assert.equal(result.ok, true);
  assert.equal(result.idempotencyKey, 'customer-request-42');
  assert.equal(result.payload.idempotencyKey, 'customer-request-42');
  assert.equal(result.snapshotHash, sha256(result.payload));
});
