'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
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

test('caller fetch hooks and tokens are ignored; only trusted resolver options reach GitHub', { skip: !HAS_SQLITE }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-queue-trust-config-'));
  const store = new AxiomStorage({ memoryPath: path.join(root, 'memory.json'), dbPath: path.join(root, 'memory.db') });
  try {
    const bytes = Buffer.from('# Trusted\n', 'utf8');
    const blobSha = gitBlobSha(bytes);
    let callerFetchCalls = 0;
    let trustedFetchCalls = 0;
    const trustedFetch = async (url, options) => {
      trustedFetchCalls += 1;
      assert.equal(options.headers.Authorization, 'Bearer trusted-token');
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

    const result = await queueReviewedExternalIngest(store, {
      sourceType: 'github',
      repoUrl: 'https://github.com/ali-ulu/huqan',
      commitSha: COMMIT_SHA,
      paths: ['README.md'],
      requester: 'user:alice',
      workspaceId: 'tenant-a',
      idempotencyKey: 'trusted-config-1',
      token: 'attacker-token',
      fetchImpl: async () => {
        callerFetchCalls += 1;
        throw new Error('caller fetch hook must be ignored');
      },
    }, {
      now: '2026-08-01T01:00:00.000Z',
      resolverOptions: { token: 'trusted-token', fetchImpl: trustedFetch },
    });

    assert.equal(result.ok, true);
    assert.equal(callerFetchCalls, 0);
    assert.equal(trustedFetchCalls, 3);
    assert.equal(JSON.stringify(result).includes('attacker-token'), false);
    assert.equal(JSON.stringify(result).includes('trusted-token'), false);
    assert.equal(JSON.stringify(store.listPendingToolApprovals(10)[0]).includes('attacker-token'), false);
    assert.equal(JSON.stringify(store.listPendingToolApprovals(10)[0]).includes('trusted-token'), false);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('caller rootPath cannot substitute for missing trusted markdownRootPath configuration', async () => {
  const store = {
    getToolApprovalByKey() { throw new Error('must fail before store lookup'); },
    saveToolApprovalIfAbsent() { throw new Error('must fail before persistence'); },
  };

  const result = await queueReviewedExternalIngest(store, {
    sourceType: 'markdown',
    rootPath: '/caller/chosen/root',
    path: 'docs/claim.md',
    requester: 'user:alice',
    workspaceId: 'tenant-a',
    idempotencyKey: 'missing-trusted-root',
  }, {
    now: '2026-08-01T01:00:00.000Z',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'EXTERNAL_QUEUE_MARKDOWN_ROOT_REQUIRED');
});
