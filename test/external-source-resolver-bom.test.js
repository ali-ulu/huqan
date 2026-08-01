'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  resolveGitHubSourceSnapshot,
  resolveMarkdownSourceSnapshot,
} = require('../lib/external-source-resolver');
const { verifyImmutableExternalSourceSnapshot } = require('../lib/ingest');

const COMMIT_SHA = 'a'.repeat(40);
const TREE_SHA = 'b'.repeat(40);
const BOM_BYTES = Buffer.from([0xef, 0xbb, 0xbf, 0x23, 0x20, 0x41, 0x0a]);
const BOM_TEXT = '\uFEFF# A\n';

function gitBlobSha(bytes) {
  return crypto.createHash('sha1')
    .update(Buffer.from(`blob ${bytes.length}\0`, 'utf8'))
    .update(bytes)
    .digest('hex');
}

function sha256Bytes(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

test('GitHub immutable resolver preserves a UTF-8 BOM byte-for-byte in snapshot content', async () => {
  const blobSha = gitBlobSha(BOM_BYTES);
  const fetchImpl = async (url) => {
    if (url.endsWith(`/git/commits/${COMMIT_SHA}`)) {
      return response({ sha: COMMIT_SHA, tree: { sha: TREE_SHA } });
    }
    if (url.includes(`/git/trees/${TREE_SHA}?recursive=1`)) {
      return response({
        sha: TREE_SHA,
        truncated: false,
        tree: [{ type: 'blob', mode: '100644', path: 'README.md', sha: blobSha }],
      });
    }
    if (url.endsWith(`/git/blobs/${blobSha}`)) {
      return response({
        sha: blobSha,
        encoding: 'base64',
        content: BOM_BYTES.toString('base64'),
        size: BOM_BYTES.length,
      });
    }
    return response({}, 404);
  };

  const result = await resolveGitHubSourceSnapshot({
    repoUrl: 'https://github.com/ali-ulu/huqan',
    commitSha: COMMIT_SHA,
    paths: ['README.md'],
  }, { fetchImpl });

  assert.equal(result.ok, true);
  const file = result.snapshot.files[0];
  assert.equal(file.content, BOM_TEXT);
  assert.equal(file.content.charCodeAt(0), 0xfeff);
  assert.equal(file.sizeBytes, BOM_BYTES.length);
  assert.equal(file.contentHash, sha256Bytes(BOM_BYTES));
  assert.equal(file.blobSha, blobSha);
  assert.equal(verifyImmutableExternalSourceSnapshot(result.snapshot).ok, true);
});

test('Markdown immutable resolver preserves a UTF-8 BOM byte-for-byte in snapshot content', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-markdown-bom-'));
  try {
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs', 'bom.md'), BOM_BYTES);

    const result = resolveMarkdownSourceSnapshot({ rootPath: root, path: 'docs/bom.md' });

    assert.equal(result.ok, true);
    const file = result.snapshot.files[0];
    assert.equal(file.content, BOM_TEXT);
    assert.equal(file.content.charCodeAt(0), 0xfeff);
    assert.equal(file.sizeBytes, BOM_BYTES.length);
    assert.equal(file.contentHash, sha256Bytes(BOM_BYTES));
    assert.equal(verifyImmutableExternalSourceSnapshot(result.snapshot).ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
