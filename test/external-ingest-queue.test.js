'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AxiomStorage = require('../storage');
const { queueReviewedExternalIngest } = require('../lib/external-ingest-queue');

let HAS_SQLITE = true;
try {
  require.resolve('better-sqlite3');
} catch (_) {
  HAS_SQLITE = false;
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-reviewed-queue-'));
  fs.mkdirSync(path.join(root, 'docs'));
  const filePath = path.join(root, 'docs', 'claim.md');
  fs.writeFileSync(filePath, '# Claim\nReviewed bytes.\n', 'utf8');
  const store = new AxiomStorage({
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
  });
  return {
    root,
    filePath,
    store,
    close() {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function markdownRequest(root, overrides = {}) {
  return {
    sourceType: 'markdown',
    rootPath: path.join(root, 'untrusted-caller-root'),
    path: 'docs/claim.md',
    requester: 'user:alice',
    workspaceId: 'tenant-a',
    idempotencyKey: 'request-1',
    requestedAt: '1990-01-01T00:00:00.000Z',
    expiresAt: '2090-01-01T00:00:00.000Z',
    authorization: 'Bearer SHOULD_NOT_PERSIST',
    ...overrides,
  };
}

function queueOptions(root, now) {
  return { now, markdownRootPath: root };
}

test('reviewed Markdown bytes are queued once with server-owned validity times and a public-safe response', { skip: !HAS_SQLITE }, async () => {
  const fixture = createFixture();
  try {
    const first = await queueReviewedExternalIngest(
      fixture.store,
      markdownRequest(fixture.root),
      queueOptions(fixture.root, '2026-08-01T01:00:00.000Z'),
    );

    assert.equal(first.ok, true);
    assert.equal(first.inserted, true);
    assert.equal(first.idempotent, false);
    assert.equal(first.approval.requestedAt, '2026-08-01T01:00:00.000Z');
    assert.equal(first.approval.expiresAt, '2026-08-01T01:15:00.000Z');
    assert.equal(first.approval.workspaceId, 'tenant-a');
    assert.equal(first.approval.requester, 'user:alice');
    assert.equal(JSON.stringify(first).includes('Reviewed bytes'), false);
    assert.equal(JSON.stringify(first).includes(fixture.root), false);
    assert.equal(JSON.stringify(first).includes('SHOULD_NOT_PERSIST'), false);

    const rows = fixture.store.listPendingToolApprovals(10);
    assert.equal(rows.length, 1);
    const persisted = rows[0];
    assert.equal(persisted.context.source, 'http-external-ingest');
    assert.equal(persisted.context.externalApproval.payload.reviewedSource.files[0].content, '# Claim\nReviewed bytes.\n');
    assert.equal(JSON.stringify(persisted).includes(fixture.root), false);
    assert.equal(JSON.stringify(persisted).includes('SHOULD_NOT_PERSIST'), false);
    assert.equal(persisted.policy.sourceAccess, 'queue_time_only');
  } finally {
    fixture.close();
  }
});

test('same reviewed request within its window is idempotent and reuses the original validity envelope', { skip: !HAS_SQLITE }, async () => {
  const fixture = createFixture();
  try {
    const first = await queueReviewedExternalIngest(
      fixture.store,
      markdownRequest(fixture.root),
      queueOptions(fixture.root, '2026-08-01T01:00:00.000Z'),
    );
    const retry = await queueReviewedExternalIngest(
      fixture.store,
      markdownRequest(fixture.root),
      queueOptions(fixture.root, '2026-08-01T01:05:00.000Z'),
    );

    assert.equal(first.ok, true);
    assert.equal(retry.ok, true);
    assert.equal(retry.inserted, false);
    assert.equal(retry.idempotent, true);
    assert.equal(retry.approval.id, first.approval.id);
    assert.equal(retry.approval.snapshotHash, first.approval.snapshotHash);
    assert.equal(retry.approval.requestedAt, first.approval.requestedAt);
    assert.equal(retry.approval.expiresAt, first.approval.expiresAt);
    assert.equal(fixture.store.countPendingToolApprovals(), 1);
  } finally {
    fixture.close();
  }
});

test('same request identity with changed reviewed bytes returns conflict and preserves the original row', { skip: !HAS_SQLITE }, async () => {
  const fixture = createFixture();
  try {
    const first = await queueReviewedExternalIngest(
      fixture.store,
      markdownRequest(fixture.root),
      queueOptions(fixture.root, '2026-08-01T01:00:00.000Z'),
    );
    assert.equal(first.ok, true);
    const before = fixture.store.listPendingToolApprovals(10)[0];

    fs.writeFileSync(fixture.filePath, '# Claim\nChanged after first queue.\n', 'utf8');
    const conflict = await queueReviewedExternalIngest(
      fixture.store,
      markdownRequest(fixture.root),
      queueOptions(fixture.root, '2026-08-01T01:05:00.000Z'),
    );

    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, 'APPROVAL_IDEMPOTENCY_CONFLICT');
    assert.equal(conflict.conflict, true);
    assert.equal(conflict.approval, undefined);
    assert.equal(conflict.existingApprovalId, before.id);
    assert.equal(fixture.store.countPendingToolApprovals(), 1);

    const after = fixture.store.listPendingToolApprovals(10)[0];
    assert.equal(after.id, before.id);
    assert.equal(after.input, before.input);
    assert.equal(after.context.externalApproval.snapshotHash, before.context.externalApproval.snapshotHash);
  } finally {
    fixture.close();
  }
});

test('a distinct idempotency key creates an independent reviewed approval', { skip: !HAS_SQLITE }, async () => {
  const fixture = createFixture();
  try {
    const first = await queueReviewedExternalIngest(
      fixture.store,
      markdownRequest(fixture.root),
      queueOptions(fixture.root, '2026-08-01T01:00:00.000Z'),
    );
    const second = await queueReviewedExternalIngest(
      fixture.store,
      markdownRequest(fixture.root, { idempotencyKey: 'request-2' }),
      queueOptions(fixture.root, '2026-08-01T01:01:00.000Z'),
    );

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.inserted, true);
    assert.notEqual(second.approval.id, first.approval.id);
    assert.equal(fixture.store.countPendingToolApprovals(), 2);
  } finally {
    fixture.close();
  }
});
