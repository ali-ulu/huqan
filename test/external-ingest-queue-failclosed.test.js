'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AxiomStorage = require('../storage');
const { EXTERNAL_INGEST_APPROVAL_VERSION } = require('../lib/external-ingest-approval');
const { queueReviewedExternalIngest } = require('../lib/external-ingest-queue');
const { sha256 } = require('../lib/ingest');

let HAS_SQLITE = true;
try {
  require.resolve('better-sqlite3');
} catch (_) {
  HAS_SQLITE = false;
}

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

function githubFetch(bytes, counter = null) {
  const blobSha = gitBlobSha(bytes);
  return async (url) => {
    if (counter) counter.calls += 1;
    if (url.endsWith(`/git/commits/${COMMIT_SHA}`)) return response({ sha: COMMIT_SHA, tree: { sha: TREE_SHA } });
    if (url.includes(`/git/trees/${TREE_SHA}?recursive=1`)) {
      return response({
        sha: TREE_SHA,
        truncated: false,
        tree: [{ type: 'blob', mode: '100644', path: 'README.md', sha: blobSha }],
      });
    }
    if (url.endsWith(`/git/blobs/${blobSha}`)) {
      return response({ sha: blobSha, encoding: 'base64', content: bytes.toString('base64'), size: bytes.length });
    }
    return response({}, 404);
  };
}

function githubRequest(overrides = {}) {
  return {
    sourceType: 'github',
    repoUrl: 'https://github.com/ali-ulu/huqan',
    commitSha: COMMIT_SHA,
    paths: ['README.md'],
    requester: 'user:alice',
    workspaceId: 'tenant-a',
    idempotencyKey: 'github-request-1',
    ...overrides,
  };
}

function withStore(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-reviewed-queue-failclosed-'));
  const store = new AxiomStorage({
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
  });
  return Promise.resolve()
    .then(() => fn(store))
    .finally(() => {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
}

function approvalKeyFor({ requester, workspaceId, idempotencyKey }) {
  const hash = sha256({
    version: EXTERNAL_INGEST_APPROVAL_VERSION,
    workspaceId,
    requester,
    idempotencyKey,
  });
  return `http.ingest.external.${hash.slice('sha256:'.length)}`;
}

test('expired persisted identities are rejected before any source access', { skip: !HAS_SQLITE }, async () => {
  await withStore(async (store) => {
    const first = await queueReviewedExternalIngest(store, githubRequest(), {
      now: '2026-08-01T01:00:00.000Z',
      resolverOptions: { fetchImpl: githubFetch(Buffer.from('# HUQAN\n', 'utf8')) },
    });
    assert.equal(first.ok, true);

    const counter = { calls: 0 };
    const expired = await queueReviewedExternalIngest(store, githubRequest(), {
      now: '2026-08-01T01:15:00.000Z',
      resolverOptions: { fetchImpl: githubFetch(Buffer.from('# HUQAN\n', 'utf8'), counter) },
    });

    assert.equal(expired.ok, false);
    assert.equal(expired.code, 'EXTERNAL_APPROVAL_EXPIRED');
    assert.equal(counter.calls, 0);
    assert.equal(store.countPendingToolApprovals(), 1);
  });
});

test('legacy occupied keys fail closed before source access', { skip: !HAS_SQLITE }, async () => {
  await withStore(async (store) => {
    const data = githubRequest();
    const approvalKey = approvalKeyFor(data);
    store.saveToolApprovalIfAbsent({
      id: 'legacy-approval',
      approvalKey,
      tool: 'http.ingest',
      input: '{}',
      context: { source: 'legacy' },
      policy: { action: 'ingest', approval: 'review' },
      status: 'pending',
      decision: 'review',
      reason: 'legacy',
    });

    const counter = { calls: 0 };
    const result = await queueReviewedExternalIngest(store, data, {
      now: '2026-08-01T01:00:00.000Z',
      resolverOptions: { fetchImpl: githubFetch(Buffer.from('# HUQAN\n', 'utf8'), counter) },
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'APPROVAL_IDEMPOTENCY_CONFLICT');
    assert.equal(result.conflict, true);
    assert.equal(result.existingApprovalId, 'legacy-approval');
    assert.equal(result.approval, undefined);
    assert.equal(counter.calls, 0);
  });
});

test('missing trusted identity and invalid queue time fail before source access', async () => {
  let calls = 0;
  const store = {
    getToolApprovalByKey() { return null; },
    saveToolApprovalIfAbsent() { throw new Error('must not persist'); },
  };
  const fetchImpl = async () => {
    calls += 1;
    throw new Error('must not fetch');
  };

  const cases = [
    [githubRequest({ requester: '' }), { now: '2026-08-01T01:00:00.000Z', resolverOptions: { fetchImpl } }],
    [githubRequest({ workspaceId: '' }), { now: '2026-08-01T01:00:00.000Z', resolverOptions: { fetchImpl } }],
    [githubRequest({ idempotencyKey: '' }), { now: '2026-08-01T01:00:00.000Z', resolverOptions: { fetchImpl } }],
    [githubRequest(), { now: 'not-a-date', resolverOptions: { fetchImpl } }],
  ];

  for (const [data, options] of cases) {
    const result = await queueReviewedExternalIngest(store, data, options);
    assert.equal(result.ok, false);
  }
  assert.equal(calls, 0);
});

test('persisted identity mismatches fail before source access and reveal no envelope', async () => {
  const data = githubRequest();
  const approvalKey = approvalKeyFor(data);
  const counter = { calls: 0 };
  const store = {
    getToolApprovalByKey() {
      return {
        id: 'mismatched',
        approval_key: approvalKey,
        status: 'pending',
        context: {
          externalApproval: {
            approvalKey,
            requestIdentityHash: `sha256:${'0'.repeat(64)}`,
            requester: data.requester,
            workspaceId: data.workspaceId,
            idempotencyKey: data.idempotencyKey,
            requestedAt: '2026-08-01T01:00:00.000Z',
            expiresAt: '2026-08-01T01:15:00.000Z',
          },
        },
      };
    },
    saveToolApprovalIfAbsent() { throw new Error('must not persist'); },
  };

  const result = await queueReviewedExternalIngest(store, data, {
    now: '2026-08-01T01:05:00.000Z',
    resolverOptions: { fetchImpl: githubFetch(Buffer.from('# HUQAN\n', 'utf8'), counter) },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'APPROVAL_IDEMPOTENCY_CONFLICT');
  assert.equal(result.conflict, true);
  assert.equal(result.approval, undefined);
  assert.equal(counter.calls, 0);
});
