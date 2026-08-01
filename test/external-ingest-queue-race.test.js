'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AxiomStorage = require('../storage');
const { resolveExternalIngestApproval } = require('../lib/external-ingest-approval');
const {
  EXTERNAL_INGEST_CONTEXT_SOURCE,
  EXTERNAL_INGEST_TOOL,
  queueReviewedExternalIngest,
} = require('../lib/external-ingest-queue');
const {
  IDEMPOTENCY_CONTEXT_KEY,
  IDEMPOTENCY_CONTEXT_VERSION,
} = require('../lib/tool-approval-idempotency');

let HAS_SQLITE = true;
try {
  require.resolve('better-sqlite3');
} catch (_) {
  HAS_SQLITE = false;
}

function queueInputSummary(approval) {
  return JSON.stringify({
    action: approval.payload.action,
    version: approval.version,
    sourceType: approval.sourceType,
    sourceRef: approval.sourceRef,
    immutableSourceId: approval.immutableSourceId,
    reviewedManifestHash: approval.reviewedManifestHash,
    snapshotHash: approval.snapshotHash,
    requester: approval.requester,
    workspaceId: approval.workspaceId,
    idempotencyKey: approval.idempotencyKey,
    requestedAt: approval.requestedAt,
    expiresAt: approval.expiresAt,
  });
}

function policy() {
  return {
    action: 'ingest_reviewed_external_snapshot',
    approval: 'review',
    snapshotIntegrity: 'sha256',
    sourceAccess: 'queue_time_only',
  };
}

function sourceRequest(root) {
  return {
    sourceType: 'markdown',
    rootPath: path.join(root, 'untrusted-caller-root'),
    path: 'docs/claim.md',
    requester: 'user:alice',
    workspaceId: 'tenant-a',
    idempotencyKey: 'race-request',
  };
}

test('persisted input is a bounded summary while reviewed bytes have one authoritative envelope copy', { skip: !HAS_SQLITE }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-queue-shape-'));
  const store = new AxiomStorage({ memoryPath: path.join(root, 'memory.json'), dbPath: path.join(root, 'memory.db') });
  try {
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs', 'claim.md'), '# Claim\nSensitive reviewed bytes.\n', 'utf8');

    const result = await queueReviewedExternalIngest(store, sourceRequest(root), {
      now: '2026-08-01T01:00:00.000Z',
      markdownRootPath: root,
    });
    assert.equal(result.ok, true);

    const persisted = store.listPendingToolApprovals(10)[0];
    assert.equal(persisted.input.includes('Sensitive reviewed bytes'), false);
    assert.equal(persisted.input.includes(root), false);
    assert.equal(persisted.context.externalApproval.payload.reviewedSource.files[0].content, '# Claim\nSensitive reviewed bytes.\n');
    assert.equal(JSON.stringify(persisted.context.externalApproval).includes(root), false);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a concurrent insert with different server timestamps is recovered as a true idempotent retry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-queue-race-'));
  try {
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs', 'claim.md'), '# Claim\nRace-safe bytes.\n', 'utf8');
    const data = sourceRequest(root);

    const concurrent = await resolveExternalIngestApproval({
      ...data,
      rootPath: root,
      requestedAt: '2026-08-01T00:59:59.900Z',
      expiresAt: '2026-08-01T01:14:59.900Z',
    });
    assert.equal(concurrent.ok, true);
    const envelope = concurrent.approval;
    const persisted = {
      id: 'concurrent-approval',
      approval_key: envelope.approvalKey,
      tool: EXTERNAL_INGEST_TOOL,
      input: queueInputSummary(envelope),
      status: 'pending',
      decision: 'review',
      reason: 'external_ingest_requires_review',
      created_at: 1,
      updated_at: 1,
      context: {
        source: EXTERNAL_INGEST_CONTEXT_SOURCE,
        externalApproval: envelope,
        [IDEMPOTENCY_CONTEXT_KEY]: {
          version: IDEMPOTENCY_CONTEXT_VERSION,
          fingerprint: envelope.snapshotHash,
        },
      },
      policy: policy(),
    };

    const store = {
      getCalls: 0,
      saveCalls: 0,
      getToolApprovalByKey() {
        this.getCalls += 1;
        return this.getCalls === 1 ? null : persisted;
      },
      saveToolApprovalIfAbsent() {
        this.saveCalls += 1;
        return { inserted: false, approval: persisted };
      },
    };

    const result = await queueReviewedExternalIngest(store, data, {
      now: '2026-08-01T01:00:00.000Z',
      markdownRootPath: root,
    });

    assert.equal(result.ok, true);
    assert.equal(result.inserted, false);
    assert.equal(result.idempotent, true);
    assert.equal(result.approval.id, 'concurrent-approval');
    assert.equal(result.approval.requestedAt, '2026-08-01T00:59:59.900Z');
    assert.equal(store.getCalls, 2);
    assert.equal(store.saveCalls, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
