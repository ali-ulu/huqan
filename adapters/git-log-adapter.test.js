const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  parseGitLog,
  isGitRepo,
  getCommits,
  ingestGitLog,
  ingestAndLearn,
} = require('./git-log-adapter');

const RS = '\x1e';
const FS = '\x1f';

function initRepo(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
}

function commit(dir, fileName, content, message) {
  fs.writeFileSync(path.join(dir, fileName), content, 'utf8');
  execFileSync('git', ['add', fileName], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: dir });
}

test('git-log-adapter: parseGitLog splits records and fields (no git needed)', () => {
  const raw = [
    ['abc123', 'Alice', 'alice@example.com', '2026-01-01T00:00:00+00:00', 'First commit', 'body line'].join(FS) + RS,
    ['def456', 'Bob', 'bob@example.com', '2026-01-02T00:00:00+00:00', 'Second commit', ''].join(FS) + RS,
  ].join('\n');

  const commits = parseGitLog(raw);
  assert.equal(commits.length, 2);
  assert.equal(commits[0].hash, 'abc123');
  assert.equal(commits[0].shortHash, 'abc123');
  assert.equal(commits[0].authorName, 'Alice');
  assert.equal(commits[0].subject, 'First commit');
  assert.equal(commits[0].body, 'body line');
  assert.equal(commits[1].hash, 'def456');
  assert.equal(commits[1].body, '');
});

test('git-log-adapter: parseGitLog handles empty output', () => {
  assert.deepEqual(parseGitLog(''), []);
  assert.deepEqual(parseGitLog('   \n  '), []);
});

test('git-log-adapter: isGitRepo distinguishes a real repo from a plain directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-gitlog-isrepo-'));
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-gitlog-notrepo-'));
  try {
    initRepo(dir);
    assert.equal(isGitRepo(dir), true);
    assert.equal(isGitRepo(notRepo), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(notRepo, { recursive: true, force: true });
  }
});

test('git-log-adapter: getCommits and ingestGitLog read a real repo', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-gitlog-root-'));
  const repoDir = path.join(rootDir, 'repo');
  fs.mkdirSync(repoDir);
  try {
    initRepo(repoDir);
    commit(repoDir, 'a.txt', 'a', 'Add a');
    commit(repoDir, 'b.txt', 'b', 'Add b\n\nWith a body line');

    const commits = getCommits(repoDir, { rootPath: rootDir });
    assert.equal(commits.length, 2);
    assert.equal(commits[0].subject, 'Add b');
    assert.equal(commits[0].body, 'With a body line');
    assert.equal(commits[1].subject, 'Add a');

    const ingested = ingestGitLog(repoDir, { rootPath: rootDir });
    assert.equal(ingested.entries.length, 2);
    assert.ok(ingested.entries[0].sourceRef.startsWith('git:'));
    assert.ok(ingested.entries[0].content.includes('Add b'));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('git-log-adapter: getCommits respects maxCommits', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-gitlog-max-'));
  const repoDir = path.join(rootDir, 'repo');
  fs.mkdirSync(repoDir);
  try {
    initRepo(repoDir);
    commit(repoDir, 'a.txt', 'a', 'First');
    commit(repoDir, 'b.txt', 'b', 'Second');
    commit(repoDir, 'c.txt', 'c', 'Third');

    const commits = getCommits(repoDir, { rootPath: rootDir, maxCommits: 2 });
    assert.equal(commits.length, 2);
    assert.equal(commits[0].subject, 'Third');
    assert.equal(commits[1].subject, 'Second');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('git-log-adapter: rejects a path that is not a git repository', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-gitlog-notgit-'));
  const plainDir = path.join(rootDir, 'plain');
  fs.mkdirSync(plainDir);
  try {
    assert.throws(
      () => getCommits(plainDir, { rootPath: rootDir }),
      /not a git repository/
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('git-log-adapter: rejects traversal and absolute paths outside root', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-gitlog-root2-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-gitlog-outside-'));
  try {
    initRepo(outsideDir);
    commit(outsideDir, 'secret.txt', 'secret', 'Secret commit');

    assert.throws(
      () => getCommits(outsideDir, { rootPath: rootDir }),
      /allowed root/i
    );
    assert.throws(
      () => getCommits(path.join(rootDir, '..', path.basename(outsideDir)), { rootPath: rootDir }),
      /allowed root/i
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('git-log-adapter: rejects a branch name that looks like a git flag (#424)', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-log-branch-'));
  const repoDir = path.join(rootDir, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  try {
    initRepo(repoDir);
    commit(repoDir, 'claim.txt', 'x', 'A bounded claim');

    // A branch name starting with '-' would be interpreted as a git flag and
    // must be rejected before execFileSync is called.
    assert.throws(
      () => getCommits(repoDir, { rootPath: rootDir, branch: '--system' }),
      (err) => err.code === 'GIT_LOG_INVALID_BRANCH',
    );
    // Other injection attempts
    assert.throws(
      () => getCommits(repoDir, { rootPath: rootDir, branch: '-e' }),
      (err) => err.code === 'GIT_LOG_INVALID_BRANCH',
    );
    // Shell metacharacters are also rejected
    assert.throws(
      () => getCommits(repoDir, { rootPath: rootDir, branch: 'main;rm -rf /' }),
      (err) => err.code === 'GIT_LOG_INVALID_BRANCH',
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('git-log-adapter: accepts a plausible branch name (#424)', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-log-branch-ok-'));
  const repoDir = path.join(rootDir, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  try {
    initRepo(repoDir);
    commit(repoDir, 'claim.txt', 'x', 'A bounded claim');
    // The default branch in this test repo is 'master'. The validation regex
    // must accept it (it starts with a letter, contains only allowed chars).
    // A GIT_LOG_INVALID_BRANCH error would mean the validation rejected it,
    // which is wrong. Other errors (e.g. git log fails) are acceptable here.
    try {
      getCommits(repoDir, { rootPath: rootDir, branch: 'master' });
    } catch (err) {
      assert.notStrictEqual(err.code, 'GIT_LOG_INVALID_BRANCH',
        'master must pass branch validation');
    }
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('git-log-adapter: ingestAndLearn forwards provenance per commit', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-gitlog-learn-'));
  const repoDir = path.join(rootDir, 'repo');
  fs.mkdirSync(repoDir);
  const calls = [];
  try {
    initRepo(repoDir);
    commit(repoDir, 'claim.txt', 'x', 'A bounded claim');

    const result = ingestAndLearn(repoDir, {
      learn(text, opts) {
        calls.push({ text, opts });
        return {
          data: { learned: 1 },
          receipt: { receiptId: 'delegated-receipt' },
        };
      },
    }, {
      rootPath: rootDir,
      actor: 'git-log-test',
    });

    assert.equal(result.learned.length, 1);
    assert.equal(result.learned[0].ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.sourceType, 'import');
    assert.equal(calls[0].opts.sourceSubType, 'git-log');
    assert.equal(calls[0].opts.provenance.source, 'git-log-adapter');
    assert.equal(calls[0].opts.provenance.actor, 'git-log-test');
    assert.match(calls[0].opts.provenance.provenanceId, /^git-log-\d+-[a-z0-9]{6}$/);
    assert.equal(calls[0].opts.provenance.sourceRef, calls[0].opts.sourceRef);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
