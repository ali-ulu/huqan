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

let HAS_SQLITE = true;
try {
  require.resolve('better-sqlite3');
} catch (_) {
  HAS_SQLITE = false;
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-reviewed-execution-'));
  fs.mkdirSync(path.join(root, 'docs'));
  const sourcePath = path.join(root, 'docs', 'claim.md');
  fs.writeFileSync(sourcePath, '# Claim\nReviewed execution bytes.\n', 'utf8');
  const store = new AxiomStorage({ memoryPath: path.join(root, 'memory.json'), dbPath: path.join(root, 'memory.db') });
  return {
    root,
    sourcePath,
    store,
    close() {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

async function queueAndClaim(fixture, options = {}) {
  const queueNow = new Date();
  const queued = await queueReviewedExternalIngest(fixture.store, {
    sourceType: 'markdown',
    rootPath: '/caller-root-must-be-ignored',
    path: 'docs/claim.md',
    requester: 'user:alice',
    workspaceId: 'tenant-a',
    idempotencyKey: options.idempotencyKey || 'execution-1',
  }, {
    now: queueNow,
    markdownRootPath: fixture.root,
  });
  assert.equal(queued.ok, true);
  const claimed = fixture.store.claimToolApprovalWithLease(queued.approval.id, {
    owner: 'worker:1',
    leaseMs: 60_000,
    reason: 'reviewed_external_execution_claimed',
  });
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.approval.status, 'executing');
  return claimed.approval;
}

test('claimed reviewed bytes produce a deeply frozen execution plan after the original source is removed', { skip: !HAS_SQLITE }, async () => {
  const fixture = createFixture();
  try {
    const executing = await queueAndClaim(fixture);
    fs.unlinkSync(fixture.sourcePath);
    const preparedAt = new Date();

    const result = prepareReviewedExternalExecution(executing, {
      now: preparedAt,
      requester: 'user:alice',
      workspaceId: 'tenant-a',
      reviewer: 'user:bob',
      leaseOwner: 'worker:1',
    });

    assert.equal(result.ok, true);
    assert.equal(result.plan.sourceType, 'markdown');
    assert.equal(result.plan.workspaceId, 'tenant-a');
    assert.equal(result.plan.requester, 'user:alice');
    assert.equal(result.plan.reviewer, 'user:bob');
    assert.equal(result.plan.selfApproval, false);
    assert.equal(result.plan.files.length, 1);
    assert.equal(result.plan.files[0].content, '# Claim\nReviewed execution bytes.\n');
    assert.match(result.plan.executionPlanHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(result.plan).includes(fixture.root), false);
    assert.equal(Object.isFrozen(result.plan), true);
    assert.equal(Object.isFrozen(result.plan.files), true);
    assert.equal(Object.isFrozen(result.plan.files[0]), true);
    assert.throws(() => { result.plan.files[0].content = '# changed'; }, TypeError);

    const repeated = prepareReviewedExternalExecution(executing, {
      now: preparedAt,
      requester: 'user:alice',
      workspaceId: 'tenant-a',
      reviewer: 'user:bob',
      leaseOwner: 'worker:1',
    });
    assert.equal(repeated.ok, true);
    assert.deepEqual(repeated.plan, result.plan);
  } finally {
    fixture.close();
  }
});

test('self-approval is made explicit without silently choosing a product policy', { skip: !HAS_SQLITE }, async () => {
  const fixture = createFixture();
  try {
    const executing = await queueAndClaim(fixture, { idempotencyKey: 'execution-self' });
    const result = prepareReviewedExternalExecution(executing, {
      now: new Date(),
      requester: 'user:alice',
      workspaceId: 'tenant-a',
      reviewer: 'user:alice',
      leaseOwner: 'worker:1',
    });

    assert.equal(result.ok, true);
    assert.equal(result.plan.requester, 'user:alice');
    assert.equal(result.plan.reviewer, 'user:alice');
    assert.equal(result.plan.selfApproval, true);
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

test('GitHub execution preparation performs no network re-fetch after queue-time resolution', { skip: !HAS_SQLITE }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-reviewed-github-execution-'));
  const store = new AxiomStorage({ memoryPath: path.join(root, 'memory.json'), dbPath: path.join(root, 'memory.db') });
  try {
    const bytes = Buffer.from('# GitHub reviewed bytes\n', 'utf8');
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
      idempotencyKey: 'github-execution',
    }, {
      now: new Date(),
      resolverOptions: { fetchImpl },
    });
    assert.equal(queued.ok, true);
    assert.equal(fetchCalls, 3);

    const claimed = store.claimToolApprovalWithLease(queued.approval.id, { owner: 'worker:github', leaseMs: 60_000 });
    assert.equal(claimed.claimed, true);
    const prepared = prepareReviewedExternalExecution(claimed.approval, {
      now: new Date(),
      requester: 'user:alice',
      workspaceId: 'tenant-a',
      reviewer: 'user:bob',
      leaseOwner: 'worker:github',
    });

    assert.equal(prepared.ok, true);
    assert.equal(fetchCalls, 3, 'execution preparation must not access GitHub');
    assert.equal(prepared.plan.files[0].content, '# GitHub reviewed bytes\n');
    assert.equal(prepared.plan.files[0].blobSha, blobSha);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
