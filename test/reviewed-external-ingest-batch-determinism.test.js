'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_EXTERNAL_SNAPSHOT_BYTES,
  sha256,
  sha256Text,
} = require('../lib/ingest');
const { REVIEWED_EXTERNAL_EXECUTION_VERSION } = require('../lib/reviewed-external-execution');
const { materializeReviewedExternalIngestBatch } = require('../lib/reviewed-external-ingest-batch');

function buildPlan(content = '# Deterministic\nReviewed bytes.\n') {
  const file = {
    path: 'docs/deterministic.md',
    content,
    contentHash: sha256Text(content),
    sizeBytes: Buffer.byteLength(content, 'utf8'),
  };
  const immutableSourceId = sha256({
    files: [{ path: file.path, contentHash: file.contentHash, sizeBytes: file.sizeBytes }],
  });
  const preparedAt = '2026-08-01T12:00:00.000Z';
  const core = {
    version: REVIEWED_EXTERNAL_EXECUTION_VERSION,
    approvalId: 'approval:deterministic',
    approvalKey: 'http.ingest.external.deterministic',
    snapshotHash: sha256({ snapshot: 'deterministic' }),
    reviewedManifestHash: sha256({ manifest: 'deterministic' }),
    sourceType: 'markdown',
    sourceRef: `file:docs@${immutableSourceId}`,
    immutableSourceId,
    workspaceId: 'tenant-a',
    requester: 'user:alice',
    reviewer: 'user:bob',
    selfApproval: false,
    leaseOwner: 'worker:1',
    leaseExpiresAt: Date.parse(preparedAt) + 60_000,
    preparedAt,
    files: [file],
  };
  return { ...core, executionPlanHash: sha256(core) };
}

function trustedOptions(plan, now) {
  return {
    now,
    approvalId: plan.approvalId,
    requester: plan.requester,
    workspaceId: plan.workspaceId,
    reviewer: plan.reviewer,
    leaseOwner: plan.leaseOwner,
  };
}

test('the same reviewed plan produces the same batch throughout its valid lease', () => {
  const plan = buildPlan();
  const first = materializeReviewedExternalIngestBatch(
    plan,
    trustedOptions(plan, '2026-08-01T12:00:01.000Z'),
  );
  const second = materializeReviewedExternalIngestBatch(
    plan,
    trustedOptions(plan, '2026-08-01T12:00:30.000Z'),
  );

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(second.batch, first.batch);
  assert.equal(Object.hasOwn(first.batch, 'materializedAt'), false);
  assert.equal(first.batch.batchHash, second.batch.batchHash);
});

test('oversized reviewed content is rejected before stale plan-hash processing', () => {
  const plan = buildPlan();
  const oversized = structuredClone(plan);
  oversized.files[0].content = 'x'.repeat(MAX_EXTERNAL_SNAPSHOT_BYTES + 1);
  oversized.files[0].contentHash = sha256Text(oversized.files[0].content);
  oversized.files[0].sizeBytes = Buffer.byteLength(oversized.files[0].content, 'utf8');

  const result = materializeReviewedExternalIngestBatch(
    oversized,
    trustedOptions(oversized, '2026-08-01T12:00:01.000Z'),
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'REVIEWED_BATCH_SIZE_LIMIT');
  assert.equal(result.batch, undefined);
});
