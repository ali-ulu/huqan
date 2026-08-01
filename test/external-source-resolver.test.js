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
const {
  MAX_EXTERNAL_SNAPSHOT_BYTES,
  buildIngestApprovalSnapshot,
  verifyImmutableExternalSourceSnapshot,
} = require('../lib/ingest');

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

function githubFixture({
  content = '# Immutable\n',
  commitSha = COMMIT_SHA,
  returnedCommitSha = COMMIT_SHA,
  treeSha = TREE_SHA,
  returnedTreeSha = treeSha,
  treeTruncated = false,
  treePath = 'README.md',
  treeMode = '100644',
  returnedBlobSha,
  blobEncoding = 'base64',
  blobContent,
  blobSize,
} = {}) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const blobSha = gitBlobSha(bytes);
  const seen = [];
  const fetchImpl = async (url, options = {}) => {
    seen.push({ url, options });
    if (url.endsWith(`/git/commits/${commitSha}`)) {
      return response({ sha: returnedCommitSha, tree: { sha: treeSha } });
    }
    if (url.includes(`/git/trees/${treeSha}?recursive=1`)) {
      return response({
        sha: returnedTreeSha,
        truncated: treeTruncated,
        tree: [{ type: 'blob', mode: treeMode, path: treePath, sha: blobSha }],
      });
    }
    if (url.endsWith(`/git/blobs/${blobSha}`)) {
      return response({
        sha: returnedBlobSha || blobSha,
        encoding: blobEncoding,
        content: blobContent == null ? bytes.toString('base64') : blobContent,
        size: blobSize == null ? bytes.length : blobSize,
      });
    }
    return response({}, 404);
  };
  return { fetchImpl, seen, blobSha, bytes };
}

test('GitHub resolver proves commit, tree, blob, and UTF-8 bytes before building snapshot', async () => {
  const fixture = githubFixture();
  const result = await resolveGitHubSourceSnapshot({
    repoUrl: 'https://github.com/ali-ulu/huqan.git',
    commitSha: COMMIT_SHA,
    paths: ['README.md'],
  }, {
    fetchImpl: fixture.fetchImpl,
    token: 'ghp_SECRET',
  });

  assert.equal(result.ok, true);
  assert.equal(result.snapshot.repoUrl, 'https://github.com/ali-ulu/huqan');
  assert.equal(result.snapshot.commitSha, COMMIT_SHA);
  assert.equal(result.snapshot.files.length, 1);
  assert.equal(result.snapshot.files[0].path, 'README.md');
  assert.equal(result.snapshot.files[0].blobSha, fixture.blobSha);
  assert.equal(result.snapshot.files[0].content, '# Immutable\n');
  assert.equal(verifyImmutableExternalSourceSnapshot(result.snapshot).ok, true);
  assert.equal(JSON.stringify(result).includes('ghp_SECRET'), false);
  assert.equal(fixture.seen.every(call => call.options.headers.Authorization === 'Bearer ghp_SECRET'), true);
  assert.equal(fixture.seen.some(call => call.url.includes('/git/commits/')), true);
  assert.equal(fixture.seen.some(call => call.url.includes('/git/trees/')), true);
  assert.equal(fixture.seen.some(call => call.url.includes('/git/blobs/')), true);

  const emptyFixture = githubFixture({ content: '' });
  const emptyResult = await resolveGitHubSourceSnapshot({
    repoUrl: 'https://github.com/ali-ulu/huqan',
    commitSha: COMMIT_SHA,
    paths: ['README.md'],
  }, { fetchImpl: emptyFixture.fetchImpl });
  assert.equal(emptyResult.ok, true);
  assert.equal(emptyResult.snapshot.files[0].content, '');
});

test('GitHub resolver fails closed on commit/tree mismatch, truncated tree, and missing path', async () => {
  const commitMismatch = githubFixture({ returnedCommitSha: 'c'.repeat(40) });
  const commitResult = await resolveGitHubSourceSnapshot({
    repoUrl: 'https://github.com/ali-ulu/huqan',
    commitSha: COMMIT_SHA,
    paths: ['README.md'],
  }, { fetchImpl: commitMismatch.fetchImpl });
  assert.equal(commitResult.ok, false);
  assert.equal(commitResult.code, 'GITHUB_COMMIT_IDENTITY_MISMATCH');

  const treeMismatch = githubFixture({ returnedTreeSha: 'd'.repeat(40) });
  const treeResult = await resolveGitHubSourceSnapshot({
    repoUrl: 'https://github.com/ali-ulu/huqan',
    commitSha: COMMIT_SHA,
    paths: ['README.md'],
  }, { fetchImpl: treeMismatch.fetchImpl });
  assert.equal(treeResult.ok, false);
  assert.equal(treeResult.code, 'GITHUB_TREE_IDENTITY_MISMATCH');

  const truncated = githubFixture({ treeTruncated: true });
  const truncatedResult = await resolveGitHubSourceSnapshot({
    repoUrl: 'https://github.com/ali-ulu/huqan',
    commitSha: COMMIT_SHA,
    paths: ['README.md'],
  }, { fetchImpl: truncated.fetchImpl });
  assert.equal(truncatedResult.ok, false);
  assert.equal(truncatedResult.code, 'GITHUB_TREE_TRUNCATED');

  const missing = githubFixture({ treePath: 'ROADMAP.md' });
  const missingResult = await resolveGitHubSourceSnapshot({
    repoUrl: 'https://github.com/ali-ulu/huqan',
    commitSha: COMMIT_SHA,
    paths: ['README.md'],
  }, { fetchImpl: missing.fetchImpl });
  assert.equal(missingResult.ok, false);
  assert.equal(missingResult.code, 'SOURCE_SNAPSHOT_PATH_NOT_FOUND');

  const symlinkMode = githubFixture({ treeMode: '120000' });
  const symlinkModeResult = await resolveGitHubSourceSnapshot({
    repoUrl: 'https://github.com/ali-ulu/huqan',
    commitSha: COMMIT_SHA,
    paths: ['README.md'],
  }, { fetchImpl: symlinkMode.fetchImpl });
  assert.equal(symlinkModeResult.ok, false);
  assert.equal(symlinkModeResult.code, 'GITHUB_TREE_MODE_UNSUPPORTED');
});

test('GitHub resolver rejects blob identity/content mismatch, invalid encoding, and invalid UTF-8', async () => {
  const identityMismatch = githubFixture({ returnedBlobSha: 'd'.repeat(40) });
  const identityResult = await resolveGitHubSourceSnapshot({
    repoUrl: 'https://github.com/ali-ulu/huqan',
    commitSha: COMMIT_SHA,
    paths: ['README.md'],
  }, { fetchImpl: identityMismatch.fetchImpl });
  assert.equal(identityResult.ok, false);
  assert.equal(identityResult.code, 'GITHUB_BLOB_IDENTITY_MISMATCH');

  const contentMismatch = githubFixture({ blobContent: Buffer.from('attacker', 'utf8').toString('base64') });
  const contentResult = await resolveGitHubSourceSnapshot({
    repoUrl: 'https://github.com/ali-ulu/huqan',
    commitSha: COMMIT_SHA,
    paths: ['README.md'],
  }, { fetchImpl: contentMismatch.fetchImpl });
  assert.equal(contentResult.ok, false);
  assert.equal(contentResult.code, 'GITHUB_BLOB_CONTENT_MISMATCH');

  const encoding = githubFixture({ blobEncoding: 'utf-8' });
  const encodingResult = await resolveGitHubSourceSnapshot({
    repoUrl: 'https://github.com/ali-ulu/huqan',
    commitSha: COMMIT_SHA,
    paths: ['README.md'],
  }, { fetchImpl: encoding.fetchImpl });
  assert.equal(encodingResult.ok, false);
  assert.equal(encodingResult.code, 'GITHUB_BLOB_ENCODING_UNSUPPORTED');

  const declaredOversize = githubFixture({ blobSize: MAX_EXTERNAL_SNAPSHOT_BYTES + 1 });
  const declaredOversizeResult = await resolveGitHubSourceSnapshot({
    repoUrl: 'https://github.com/ali-ulu/huqan',
    commitSha: COMMIT_SHA,
    paths: ['README.md'],
  }, { fetchImpl: declaredOversize.fetchImpl });
  assert.equal(declaredOversizeResult.ok, false);
  assert.equal(declaredOversizeResult.code, 'SOURCE_SNAPSHOT_SIZE_LIMIT');

  const invalidUtf8 = githubFixture({ content: Buffer.from([0xc3, 0x28]) });
  const utf8Result = await resolveGitHubSourceSnapshot({
    repoUrl: 'https://github.com/ali-ulu/huqan',
    commitSha: COMMIT_SHA,
    paths: ['README.md'],
  }, { fetchImpl: invalidUtf8.fetchImpl });
  assert.equal(utf8Result.ok, false);
  assert.equal(utf8Result.code, 'SOURCE_SNAPSHOT_UTF8_REQUIRED');
});

test('GitHub resolver rejects mutable or malformed source selectors before network access', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return response({}, 500); };

  for (const commitSha of ['', 'main', 'abc123']) {
    const result = await resolveGitHubSourceSnapshot({
      repoUrl: 'https://github.com/ali-ulu/huqan',
      commitSha,
      paths: ['README.md'],
    }, { fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'IMMUTABLE_SOURCE_ID_REQUIRED');
  }

  const traversal = await resolveGitHubSourceSnapshot({
    repoUrl: 'https://github.com/ali-ulu/huqan',
    commitSha: COMMIT_SHA,
    paths: ['../secret.md'],
  }, { fetchImpl });
  assert.equal(traversal.ok, false);
  assert.equal(traversal.code, 'SOURCE_SNAPSHOT_PATH_INVALID');
  assert.equal(calls, 0);
});

test('Markdown resolver reads only stable UTF-8 markdown files beneath canonical root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-markdown-resolver-'));
  try {
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs', 'a.md'), '# A\n', 'utf8');
    fs.writeFileSync(path.join(root, 'docs', 'b.markdown'), '# B\n', 'utf8');
    fs.writeFileSync(path.join(root, 'docs', 'ignored.txt'), 'ignored', 'utf8');

    const result = resolveMarkdownSourceSnapshot({
      rootPath: root,
      path: 'docs',
    });

    assert.equal(result.ok, true);
    assert.equal(result.snapshot.rootPath, fs.realpathSync(root));
    assert.equal(result.snapshot.path, 'docs');
    assert.deepEqual(result.snapshot.files.map(file => file.path), ['docs/a.md', 'docs/b.markdown']);
    assert.equal(verifyImmutableExternalSourceSnapshot(result.snapshot).ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Markdown resolver fails closed on traversal, symlinks, invalid UTF-8, and oversized sources', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-markdown-resolver-negative-'));
  try {
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs', 'valid.md'), '# Valid\n', 'utf8');

    const traversal = resolveMarkdownSourceSnapshot({ rootPath: root, path: '../outside.md' });
    assert.equal(traversal.ok, false);
    assert.equal(traversal.code, 'SOURCE_SNAPSHOT_PATH_INVALID');

    const missing = resolveMarkdownSourceSnapshot({ rootPath: root, path: 'docs/missing.md' });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'MARKDOWN_SOURCE_NOT_FOUND');

    const invalidPath = path.join(root, 'docs', 'invalid.md');
    fs.writeFileSync(invalidPath, Buffer.from([0xc3, 0x28]));
    const invalidUtf8 = resolveMarkdownSourceSnapshot({ rootPath: root, path: 'docs/invalid.md' });
    assert.equal(invalidUtf8.ok, false);
    assert.equal(invalidUtf8.code, 'SOURCE_SNAPSHOT_UTF8_REQUIRED');
    fs.rmSync(invalidPath);

    const oversizedPath = path.join(root, 'docs', 'oversized.md');
    fs.writeFileSync(oversizedPath, 'x'.repeat(MAX_EXTERNAL_SNAPSHOT_BYTES + 1), 'utf8');
    const oversized = resolveMarkdownSourceSnapshot({ rootPath: root, path: 'docs/oversized.md' });
    assert.equal(oversized.ok, false);
    assert.equal(oversized.code, 'SOURCE_SNAPSHOT_SIZE_LIMIT');
    fs.rmSync(oversizedPath);

    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-markdown-external-'));
    try {
      fs.writeFileSync(path.join(external, 'secret.md'), '# Secret\n', 'utf8');
      fs.symlinkSync(path.join(external, 'secret.md'), path.join(root, 'docs', 'link.md'));
      const symlink = resolveMarkdownSourceSnapshot({ rootPath: root, path: 'docs' });
      assert.equal(symlink.ok, false);
      assert.equal(symlink.code, 'MARKDOWN_SYMLINK_UNSUPPORTED');
    } finally {
      fs.rmSync(external, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('trusted resolver package does not open external approval queueing', () => {
  for (const sourceType of ['github', 'repo', 'markdown']) {
    const result = buildIngestApprovalSnapshot({
      sourceType,
      repoUrl: 'https://github.com/ali-ulu/huqan',
      commitSha: COMMIT_SHA,
      path: 'docs',
      rootPath: '/workspace',
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INGEST_SNAPSHOT_REQUIRED');
  }
});
