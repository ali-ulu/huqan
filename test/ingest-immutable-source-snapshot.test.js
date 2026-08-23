'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  EXTERNAL_SOURCE_SNAPSHOT_VERSION,
  buildImmutableExternalSourceSnapshot,
  verifyImmutableExternalSourceSnapshot,
  buildIngestApprovalSnapshot,
} = require('../lib/ingest');

const COMMIT_SHA = 'a'.repeat(40);
const BLOB_SHA = 'b'.repeat(40);

function githubInput(files) {
  return {
    sourceType: 'github',
    repoUrl: 'https://github.com/ali-ulu/huqan.git',
    commitSha: COMMIT_SHA,
    files,
  };
}

test('GitHub immutable snapshots require a canonical repository and full commit SHA', () => {
  const withoutSha = buildImmutableExternalSourceSnapshot({
    sourceType: 'github',
    repoUrl: 'https://github.com/ali-ulu/huqan',
    files: [{ path: 'README.md', content: '# HUQAN' }],
  });
  assert.equal(withoutSha.ok, false);
  assert.equal(withoutSha.code, 'IMMUTABLE_SOURCE_ID_REQUIRED');

  const shortSha = buildImmutableExternalSourceSnapshot({
    ...githubInput([{ path: 'README.md', content: '# HUQAN' }]),
    commitSha: 'abc123',
  });
  assert.equal(shortSha.ok, false);
  assert.equal(shortSha.code, 'IMMUTABLE_SOURCE_ID_REQUIRED');

  const credentialedRepo = buildImmutableExternalSourceSnapshot({
    ...githubInput([{ path: 'README.md', content: '# HUQAN' }]),
    repoUrl: 'https://user:secret@github.com/ali-ulu/huqan',
  });
  assert.equal(credentialedRepo.ok, false);
  assert.equal(credentialedRepo.code, 'SOURCE_SNAPSHOT_REPO_INVALID');
});

test('GitHub snapshot manifest is deterministic, content-bound, and branch-free', () => {
  const first = buildImmutableExternalSourceSnapshot(githubInput([
    { path: 'docs/roadmap.md', content: '# Roadmap' },
    { path: 'README.md', content: '# HUQAN', blobSha: BLOB_SHA },
  ]));
  const second = buildImmutableExternalSourceSnapshot(githubInput([
    { path: 'README.md', content: '# HUQAN', blobSha: BLOB_SHA },
    { path: 'docs/roadmap.md', content: '# Roadmap' },
  ]));

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.snapshot.version, EXTERNAL_SOURCE_SNAPSHOT_VERSION);
  assert.equal(first.snapshot.repoUrl, 'https://github.com/ali-ulu/huqan');
  assert.equal(first.snapshot.commitSha, COMMIT_SHA);
  assert.equal(first.snapshot.immutableSourceId, COMMIT_SHA);
  assert.equal(first.snapshot.sourceRef, `https://github.com/ali-ulu/huqan@${COMMIT_SHA}`);
  assert.equal(first.snapshot.sourceRef.includes('main'), false);
  assert.deepEqual(first.snapshot.files.map(file => file.path), ['README.md', 'docs/roadmap.md']);
  assert.match(first.snapshot.files[0].contentHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(first.snapshot.manifestHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.snapshot.manifestHash, second.snapshot.manifestHash);
  assert.deepEqual(first.snapshot.files, second.snapshot.files);

  const changed = buildImmutableExternalSourceSnapshot(githubInput([
    { path: 'docs/roadmap.md', content: '# Changed roadmap' },
    { path: 'README.md', content: '# HUQAN', blobSha: BLOB_SHA },
  ]));
  assert.equal(changed.ok, true);
  assert.notEqual(changed.snapshot.manifestHash, first.snapshot.manifestHash);
});

test('snapshot verification fails closed on content, metadata, commit, or manifest tampering', () => {
  const built = buildImmutableExternalSourceSnapshot(githubInput([
    { path: 'README.md', content: '# HUQAN', blobSha: BLOB_SHA },
  ]));
  assert.equal(built.ok, true);
  const verified = verifyImmutableExternalSourceSnapshot(built.snapshot);
  assert.equal(verified.ok, true);
  assert.deepEqual(verified.snapshot, built.snapshot);

  const contentTamper = structuredClone(built.snapshot);
  contentTamper.files[0].content = '# attacker content';
  const contentVerdict = verifyImmutableExternalSourceSnapshot(contentTamper);
  assert.equal(contentVerdict.ok, false);
  assert.equal(contentVerdict.code, 'SOURCE_SNAPSHOT_CONTENT_HASH_MISMATCH');

  const sizeTamper = structuredClone(built.snapshot);
  sizeTamper.files[0].sizeBytes += 1;
  const sizeVerdict = verifyImmutableExternalSourceSnapshot(sizeTamper);
  assert.equal(sizeVerdict.ok, false);
  assert.equal(sizeVerdict.code, 'SOURCE_SNAPSHOT_INTEGRITY_MISMATCH');

  const commitTamper = structuredClone(built.snapshot);
  commitTamper.commitSha = 'c'.repeat(40);
  const commitVerdict = verifyImmutableExternalSourceSnapshot(commitTamper);
  assert.equal(commitVerdict.ok, false);
  assert.equal(commitVerdict.code, 'SOURCE_SNAPSHOT_INTEGRITY_MISMATCH');

  const manifestTamper = structuredClone(built.snapshot);
  manifestTamper.manifestHash = `sha256:${'0'.repeat(64)}`;
  const manifestVerdict = verifyImmutableExternalSourceSnapshot(manifestTamper);
  assert.equal(manifestVerdict.ok, false);
  assert.equal(manifestVerdict.code, 'SOURCE_SNAPSHOT_INTEGRITY_MISMATCH');
});

test('snapshot verification rejects unknown top-level and file fields', () => {
  const built = buildImmutableExternalSourceSnapshot(githubInput([
    { path: 'README.md', content: '# HUQAN' },
  ]));
  assert.equal(built.ok, true);

  const topLevelSecret = structuredClone(built.snapshot);
  topLevelSecret.token = 'ghp_SECRET';
  const topLevelVerdict = verifyImmutableExternalSourceSnapshot(topLevelSecret);
  assert.equal(topLevelVerdict.ok, false);
  assert.equal(topLevelVerdict.code, 'SOURCE_SNAPSHOT_FIELD_UNSUPPORTED');

  const fileSecret = structuredClone(built.snapshot);
  fileSecret.files[0].authorization = 'Bearer secret';
  const fileVerdict = verifyImmutableExternalSourceSnapshot(fileSecret);
  assert.equal(fileVerdict.ok, false);
  assert.equal(fileVerdict.code, 'SOURCE_SNAPSHOT_FIELD_UNSUPPORTED');
});

test('snapshot verification refuses Object.prototype source types without throwing', () => {
  for (const sourceType of ['constructor', '__proto__', 'toString', 'valueOf']) {
    const result = verifyImmutableExternalSourceSnapshot({
      version: EXTERNAL_SOURCE_SNAPSHOT_VERSION,
      sourceType,
      files: [],
    });
    assert.deepEqual(result, {
      ok: false,
      code: 'SOURCE_SNAPSHOT_FIELD_UNSUPPORTED',
      error: 'source snapshot contains unsupported fields',
    }, sourceType);
  }
});

test('snapshot paths reject traversal, encoding, absolute paths, controls, and duplicates', () => {
  const unsafePaths = [
    '../secret.md',
    '/etc/passwd',
    'C:/secret.md',
    'docs//claim.md',
    '%2e%2e/secret.md',
    'docs/%2fsecret.md',
    'docs/claim.md\u0000.txt',
    'docs/trailing. ',
  ];

  for (const unsafePath of unsafePaths) {
    const result = buildImmutableExternalSourceSnapshot(githubInput([
      { path: unsafePath, content: 'secret' },
    ]));
    assert.equal(result.ok, false, JSON.stringify(unsafePath));
    assert.equal(result.code, 'SOURCE_SNAPSHOT_PATH_INVALID');
  }

  const duplicate = buildImmutableExternalSourceSnapshot(githubInput([
    { path: 'README.md', content: 'one' },
    { path: 'readme.md', content: 'two' },
  ]));
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, 'SOURCE_SNAPSHOT_PATH_DUPLICATE');

  const unicodeDuplicate = buildImmutableExternalSourceSnapshot(githubInput([
    { path: 'docs/café.md', content: 'one' },
    { path: 'docs/cafe\u0301.md', content: 'two' },
  ]));
  assert.equal(unicodeDuplicate.ok, false);
  assert.equal(unicodeDuplicate.code, 'SOURCE_SNAPSHOT_PATH_DUPLICATE');
});

test('Markdown snapshot binds only markdown files inside the reviewed target', () => {
  const built = buildImmutableExternalSourceSnapshot({
    sourceType: 'markdown',
    rootPath: '/workspace/docs',
    path: 'decisions',
    files: [
      { path: 'decisions/a.md', content: '# A' },
      { path: 'decisions/b.markdown', content: '# B' },
    ],
  });

  assert.equal(built.ok, true);
  assert.equal(built.snapshot.sourceType, 'markdown');
  assert.match(built.snapshot.immutableSourceId, /^sha256:[0-9a-f]{64}$/);
  assert.equal(built.snapshot.sourceRef, `file:decisions@${built.snapshot.immutableSourceId}`);
  assert.equal(verifyImmutableExternalSourceSnapshot(built.snapshot).ok, true);

  const singleFile = buildImmutableExternalSourceSnapshot({
    sourceType: 'markdown',
    rootPath: '/workspace/docs',
    path: 'claim.md',
    content: '# Claim',
  });
  assert.equal(singleFile.ok, true);
  assert.equal(singleFile.snapshot.files[0].path, 'claim.md');

  const outsideTarget = buildImmutableExternalSourceSnapshot({
    sourceType: 'markdown',
    rootPath: '/workspace/docs',
    path: 'decisions',
    files: [{ path: 'other/claim.md', content: '# Outside' }],
  });
  assert.equal(outsideTarget.ok, false);
  assert.equal(outsideTarget.code, 'SOURCE_SNAPSHOT_SCOPE_MISMATCH');

  const nonMarkdown = buildImmutableExternalSourceSnapshot({
    sourceType: 'markdown',
    rootPath: '/workspace/docs',
    path: 'decisions',
    files: [{ path: 'decisions/secret.txt', content: 'secret' }],
  });
  assert.equal(nonMarkdown.ok, false);
  assert.equal(nonMarkdown.code, 'SOURCE_SNAPSHOT_MARKDOWN_REQUIRED');

  const blobSha = buildImmutableExternalSourceSnapshot({
    sourceType: 'markdown',
    rootPath: '/workspace/docs',
    path: 'decisions',
    files: [{ path: 'decisions/a.md', content: '# A', blobSha: BLOB_SHA }],
  });
  assert.equal(blobSha.ok, false);
  assert.equal(blobSha.code, 'SOURCE_SNAPSHOT_BLOB_SHA_UNEXPECTED');

  const noRoot = buildImmutableExternalSourceSnapshot({
    sourceType: 'markdown',
    path: 'claim.md',
    content: '# Claim',
  });
  assert.equal(noRoot.ok, false);
  assert.equal(noRoot.code, 'MARKDOWN_ROOT_REQUIRED');
});

test('adding snapshot primitives does not widen the external approval gate', () => {
  for (const sourceType of ['github', 'repo', 'markdown']) {
    const result = buildIngestApprovalSnapshot({
      sourceType,
      repoUrl: 'https://github.com/ali-ulu/huqan',
      commitSha: COMMIT_SHA,
      path: 'README.md',
      rootPath: '/workspace',
      files: [{ path: 'README.md', content: '# HUQAN' }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INGEST_SNAPSHOT_REQUIRED');
    assert.equal(result.payload, undefined);
    assert.equal(result.snapshotHash, undefined);
  }
});
