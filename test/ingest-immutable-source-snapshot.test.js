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
  assert.deepEqual(
    first.snapshot.files.map(file => file.path),
    ['docs/roadmap.md', 'README.md'].sort((left, right) => left.localeCompare(right))
  );
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

test('snapshot verification fails closed on content, commit, or manifest tampering', () => {
  const built = buildImmutableExternalSourceSnapshot(githubInput([
    { path: 'README.md', content: '# HUQAN', blobSha: BLOB_SHA },
  ]));
  assert.equal(built.ok, true);
  assert.equal(verifyImmutableExternalSourceSnapshot(built.snapshot).ok, true);

  const contentTamper = structuredClone(built.snapshot);
  contentTamper.files[0].content = '# attacker content';
  const contentVerdict = verifyImmutableExternalSourceSnapshot(contentTamper);
  assert.equal(contentVerdict.ok, false);
  assert.equal(contentVerdict.code, 'SOURCE_SNAPSHOT_CONTENT_HASH_MISMATCH');

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

test('snapshot paths reject traversal, absolute paths, and case-insensitive duplicates', () => {
  for (const unsafePath of ['../secret.md', '/etc/passwd', 'C:/secret.md', 'docs//claim.md']) {
    const result = buildImmutableExternalSourceSnapshot(githubInput([
      { path: unsafePath, content: 'secret' },
    ]));
    assert.equal(result.ok, false, unsafePath);
    assert.equal(result.code, 'SOURCE_SNAPSHOT_PATH_INVALID');
  }

  const duplicate = buildImmutableExternalSourceSnapshot(githubInput([
    { path: 'README.md', content: 'one' },
    { path: 'readme.md', content: 'two' },
  ]));
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, 'SOURCE_SNAPSHOT_PATH_DUPLICATE');
});

test('Markdown snapshot binds bounded paths to an aggregate content identity', () => {
  const built = buildImmutableExternalSourceSnapshot({
    sourceType: 'markdown',
    rootPath: '/workspace/docs',
    path: 'decisions',
    files: [
      { path: 'decisions/a.md', content: '# A' },
      { path: 'decisions/b.md', content: '# B' },
    ],
  });

  assert.equal(built.ok, true);
  assert.equal(built.snapshot.sourceType, 'markdown');
  assert.match(built.snapshot.immutableSourceId, /^sha256:[0-9a-f]{64}$/);
  assert.equal(built.snapshot.sourceRef, `file:decisions@${built.snapshot.immutableSourceId}`);
  assert.equal(verifyImmutableExternalSourceSnapshot(built.snapshot).ok, true);

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
