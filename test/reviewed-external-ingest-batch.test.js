'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AxiomStorage = require('../storage');
const { queueReviewedExternalIngest } = require('../lib/external-ingest-queue');
const { prepareReviewedExternalExecution } = require('../lib/reviewed-external-execution');
const {
  MAX_EXTERNAL_SNAPSHOT_FILES,
  MAX_EXTERNAL_SNAPSHOT_BYTES,
  sha256,
  sha256Text,
} = require('../lib/ingest');
const {
  REVIEWED_EXTERNAL_INGEST_BATCH_VERSION,
  REVIEWED_EXTERNAL_DOCUMENT_VERSION,
  materializeReviewedExternalIngestBatch,
} = require('../lib/reviewed-external-ingest-batch');

let HAS_SQLITE = true;
try {
  require.resolve('better-sqlite3');
} catch (_) {
  HAS_SQLITE = false;
}

function createMarkdownFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-reviewed-batch-'));
  const sourceRoot = path.join(root, 'source');
  fs.mkdirSync(path.join(sourceRoot, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'docs', 'a.md'), '# A\nReviewed A bytes.\n', 'utf8');
  fs.writeFileSync(path.join(sourceRoot, 'docs', 'b.markdown'), '# B\nReviewed B bytes.\n', 'utf8');
  const store = new AxiomStorage({
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
  });
  return {
    root,
    sourceRoot,
    store,
    close() {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

async function prepareMarkdownPlan(fixture, overrides = {}) {
  const queued = await queueReviewedExternalIngest(fixture.store, {
    sourceType: 'markdown',
    path: 'docs',
    requester: 'user:alice',
    workspaceId: 'tenant-a',
    idempotencyKey: overrides.idempotencyKey || 'reviewed-batch-1',
  }, {
    now: new Date(),
    markdownRootPath: fixture.sourceRoot,
  });
  assert.equal(queued.ok, true);
  const claimed = fixture.store.claimToolApprovalWithLease(queued.approval.id, {
    owner: 'worker:1',
    leaseMs: 120_000,
    reason: 'reviewed_external_batch_claimed',
  });
  assert.equal(claimed.claimed, true);
  const now = new Date();
  const prepared = prepareReviewedExternalExecution(claimed.approval, {
    now,
    requester: 'user:alice',
    workspaceId: 'tenant-a',
    reviewer: overrides.reviewer || 'user:bob',
    leaseOwner: 'worker:1',
  });
  assert.equal(prepared.ok, true);
  return { plan: prepared.plan, now };
}

function trustedOptions(plan, overrides = {}) {
  return {
    now: overrides.now || new Date(plan.preparedAt),
    approvalId: overrides.approvalId || plan.approvalId,
    requester: overrides.requester || plan.requester,
    workspaceId: overrides.workspaceId || plan.workspaceId,
    reviewer: overrides.reviewer || plan.reviewer,
    leaseOwner: overrides.leaseOwner || plan.leaseOwner,
  };
}

function rehashPlan(input) {
  const plan = structuredClone(input);
  const core = structuredClone(plan);
  delete core.executionPlanHash;
  plan.executionPlanHash = sha256(core);
  return plan;
}

test('reviewed execution plan materializes a deterministic deeply frozen in-memory batch after source deletion', { skip: !HAS_SQLITE }, async () => {
  const fixture = createMarkdownFixture();
  try {
    const { plan, now } = await prepareMarkdownPlan(fixture);
    fs.rmSync(fixture.sourceRoot, { recursive: true, force: true });

    const result = materializeReviewedExternalIngestBatch(plan, trustedOptions(plan, { now }));
    assert.equal(result.ok, true);
    assert.equal(result.batch.version, REVIEWED_EXTERNAL_INGEST_BATCH_VERSION);
    assert.equal(result.batch.executionPlanHash, plan.executionPlanHash);
    assert.equal(result.batch.fileCount, 2);
    assert.equal(result.batch.totalBytes, plan.files.reduce((sum, file) => sum + file.sizeBytes, 0));
    assert.equal(result.batch.documents[0].version, REVIEWED_EXTERNAL_DOCUMENT_VERSION);
    assert.deepEqual(result.batch.documents.map(item => item.path), ['docs/a.md', 'docs/b.markdown']);
    assert.deepEqual(result.batch.documents.map(item => item.content), [
      '# A\nReviewed A bytes.\n',
      '# B\nReviewed B bytes.\n',
    ]);
    assert.match(result.batch.batchHash, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(Object.isFrozen(result.batch), true);
    assert.equal(Object.isFrozen(result.batch.documents), true);
    assert.equal(Object.isFrozen(result.batch.documents[0]), true);
    assert.throws(() => { result.batch.documents[0].content = 'changed'; }, TypeError);
    assert.equal(JSON.stringify(result.batch).includes(fixture.root), false);

    const repeated = materializeReviewedExternalIngestBatch(plan, trustedOptions(plan, { now }));
    assert.equal(repeated.ok, true);
    assert.deepEqual(repeated.batch, result.batch);
  } finally {
    fixture.close();
  }
});

test('self-approval remains visible without choosing an allow or reject policy', { skip: !HAS_SQLITE }, async () => {
  const fixture = createMarkdownFixture();
  try {
    const { plan, now } = await prepareMarkdownPlan(fixture, {
      idempotencyKey: 'reviewed-batch-self',
      reviewer: 'user:alice',
    });
    const result = materializeReviewedExternalIngestBatch(plan, trustedOptions(plan, { now }));
    assert.equal(result.ok, true);
    assert.equal(result.batch.requester, 'user:alice');
    assert.equal(result.batch.reviewer, 'user:alice');
    assert.equal(result.batch.selfApproval, true);
  } finally {
    fixture.close();
  }
});

const COMMIT_SHA = 'a'.repeat(40);
const TREE_SHA = 'b'.repeat(40);

function gitBlobSha(bytes) {
  return crypto.createHash('sha1')
    .update(Buffer.from(`blob ${bytes.length}\0`, 'utf8'))
    .update(bytes)
    .digest('hex');
}

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

test('GitHub reviewed bytes materialize without a network re-fetch and retain blob identity', { skip: !HAS_SQLITE }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-reviewed-github-batch-'));
  const store = new AxiomStorage({ memoryPath: path.join(root, 'memory.json'), dbPath: path.join(root, 'memory.db') });
  try {
    const bytes = Buffer.from('# GitHub reviewed batch\n', 'utf8');
    const blobSha = gitBlobSha(bytes);
    let fetchCalls = 0;
    const fetchImpl = async (url) => {
      fetchCalls += 1;
      if (url.endsWith(`/git/commits/${COMMIT_SHA}`)) return response({ sha: COMMIT_SHA, tree: { sha: TREE_SHA } });
      if (url.includes(`/git/trees/${TREE_SHA}?recursive=1`)) {
        return response({ sha: TREE_SHA, truncated: false, tree: [{ type: 'blob', mode: '100644', path: 'README.md', sha: blobSha }] });
      }
      if (url.endsWith(`/git/blobs/${blobSha}`)) {
        return response({ sha: blobSha, encoding: 'base64', content: bytes.toString('base64'), size: bytes.length });
      }
      return response({}, 404);
    };

    const queued = await queueReviewedExternalIngest(store, {
      sourceType: 'github',
      repoUrl: 'https://github.com/ali-ulu/huqan',
      commitSha: COMMIT_SHA,
      paths: ['README.md'],
      requester: 'user:alice',
      workspaceId: 'tenant-a',
      idempotencyKey: 'reviewed-github-batch',
    }, {
      now: new Date(),
      resolverOptions: { fetchImpl },
    });
    assert.equal(queued.ok, true);
    assert.equal(fetchCalls, 3);

    const claimed = store.claimToolApprovalWithLease(queued.approval.id, { owner: 'worker:github', leaseMs: 120_000 });
    assert.equal(claimed.claimed, true);
    const now = new Date();
    const prepared = prepareReviewedExternalExecution(claimed.approval, {
      now,
      requester: 'user:alice',
      workspaceId: 'tenant-a',
      reviewer: 'user:bob',
      leaseOwner: 'worker:github',
    });
    assert.equal(prepared.ok, true);

    const materialized = materializeReviewedExternalIngestBatch(prepared.plan, trustedOptions(prepared.plan, { now }));
    assert.equal(materialized.ok, true);
    assert.equal(fetchCalls, 3, 'batch materialization must not access GitHub');
    assert.equal(materialized.batch.documents[0].content, '# GitHub reviewed batch\n');
    assert.equal(materialized.batch.documents[0].blobSha, blobSha);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('plan tampering, trust-context mismatch, and lifecycle mismatch fail closed', { skip: !HAS_SQLITE }, async () => {
  const fixture = createMarkdownFixture();
  try {
    const { plan, now } = await prepareMarkdownPlan(fixture, { idempotencyKey: 'reviewed-batch-failclosed' });

    const extraField = structuredClone(plan);
    extraField.extra = true;
    assert.equal(materializeReviewedExternalIngestBatch(extraField, trustedOptions(plan, { now })).code, 'REVIEWED_BATCH_PLAN_FIELDS_INVALID');

    const unboundTamper = structuredClone(plan);
    unboundTamper.files[0].content = 'changed';
    assert.equal(materializeReviewedExternalIngestBatch(unboundTamper, trustedOptions(plan, { now })).code, 'REVIEWED_BATCH_PLAN_HASH_MISMATCH');

    const reboundContentMismatch = structuredClone(plan);
    reboundContentMismatch.files[0].content = 'changed';
    const rebound = rehashPlan(reboundContentMismatch);
    assert.equal(materializeReviewedExternalIngestBatch(rebound, trustedOptions(rebound, { now })).code, 'REVIEWED_BATCH_CONTENT_MISMATCH');

    assert.equal(
      materializeReviewedExternalIngestBatch(plan, trustedOptions(plan, { now, workspaceId: 'tenant-other' })).code,
      'REVIEWED_BATCH_TRUST_CONTEXT_MISMATCH',
    );

    const selfApprovalMismatch = structuredClone(plan);
    selfApprovalMismatch.selfApproval = true;
    const reboundSelfApproval = rehashPlan(selfApprovalMismatch);
    assert.equal(
      materializeReviewedExternalIngestBatch(reboundSelfApproval, trustedOptions(reboundSelfApproval, { now })).code,
      'REVIEWED_BATCH_SELF_APPROVAL_INVALID',
    );

    const expired = structuredClone(plan);
    expired.leaseExpiresAt = Date.parse(plan.preparedAt) + 1000;
    const reboundExpired = rehashPlan(expired);
    assert.equal(
      materializeReviewedExternalIngestBatch(reboundExpired, trustedOptions(reboundExpired, {
        now: new Date(expired.leaseExpiresAt),
      })).code,
      'REVIEWED_BATCH_LEASE_EXPIRED',
    );

    assert.equal(
      materializeReviewedExternalIngestBatch(plan, trustedOptions(plan, {
        now: new Date(Date.parse(plan.preparedAt) - 1),
      })).code,
      'REVIEWED_BATCH_NOT_YET_VALID',
    );
  } finally {
    fixture.close();
  }
});

test('file ordering, path, field, count, and byte limits fail closed even when a plan is rehashed', { skip: !HAS_SQLITE }, async () => {
  const fixture = createMarkdownFixture();
  try {
    const { plan, now } = await prepareMarkdownPlan(fixture, { idempotencyKey: 'reviewed-batch-limits' });

    const reversed = structuredClone(plan);
    reversed.files.reverse();
    const reboundReversed = rehashPlan(reversed);
    assert.equal(
      materializeReviewedExternalIngestBatch(reboundReversed, trustedOptions(reboundReversed, { now })).code,
      'REVIEWED_BATCH_FILE_ORDER_INVALID',
    );

    const nonMarkdown = structuredClone(plan);
    nonMarkdown.files[0].path = 'docs/a.txt';
    const reboundNonMarkdown = rehashPlan(nonMarkdown);
    assert.equal(
      materializeReviewedExternalIngestBatch(reboundNonMarkdown, trustedOptions(reboundNonMarkdown, { now })).code,
      'REVIEWED_BATCH_MARKDOWN_PATH_REQUIRED',
    );

    const unexpectedBlob = structuredClone(plan);
    unexpectedBlob.files[0].blobSha = 'a'.repeat(40);
    const reboundUnexpectedBlob = rehashPlan(unexpectedBlob);
    assert.equal(
      materializeReviewedExternalIngestBatch(reboundUnexpectedBlob, trustedOptions(reboundUnexpectedBlob, { now })).code,
      'REVIEWED_BATCH_FILE_FIELDS_INVALID',
    );

    const tooMany = structuredClone(plan);
    tooMany.files = Array.from({ length: MAX_EXTERNAL_SNAPSHOT_FILES + 1 }, (_, index) => {
      const content = `# ${index}\n`;
      return {
        path: `docs/${String(index).padStart(3, '0')}.md`,
        content,
        contentHash: sha256Text(content),
        sizeBytes: Buffer.byteLength(content, 'utf8'),
      };
    });
    const reboundTooMany = rehashPlan(tooMany);
    assert.equal(
      materializeReviewedExternalIngestBatch(reboundTooMany, trustedOptions(reboundTooMany, { now })).code,
      'REVIEWED_BATCH_FILE_LIMIT',
    );

    const oversized = structuredClone(plan);
    const largeContent = 'x'.repeat(MAX_EXTERNAL_SNAPSHOT_BYTES + 1);
    oversized.files = [{
      path: 'docs/large.md',
      content: largeContent,
      contentHash: sha256Text(largeContent),
      sizeBytes: Buffer.byteLength(largeContent, 'utf8'),
    }];
    const reboundOversized = rehashPlan(oversized);
    assert.equal(
      materializeReviewedExternalIngestBatch(reboundOversized, trustedOptions(reboundOversized, { now })).code,
      'REVIEWED_BATCH_SIZE_LIMIT',
    );
  } finally {
    fixture.close();
  }
});
