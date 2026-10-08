'use strict';

/**
 * coder must not refuse a clean tree because of files it produced itself
 * (#3642).
 *
 * The documented invocation keeps the task file in the repository, and the
 * command's default durable store drops `memory.db` beside it. The gate read
 * `git status`, saw both as untracked, and held every ordinary run at
 * DIRTY_REPO_REVIEW_REQUIRED before classifying the change. These tests pin
 * the split: HUQAN's own runtime files and the caller's own task file are not
 * dirt; any other untracked file still is, and is named in the output.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readRepoState, runCliCoder } = require('../lib/cli-coder');
const { isRuntimeArtifact, partitionUntracked } = require('../lib/repo-artifacts');

function makeRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-untracked-')));
}

function makeGitRoot() {
  const root = makeRoot();
  const git = (args) => childProcess.execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  git(['init', '-b', 'feat/coder-untracked-test', '-q']);
  git(['config', 'user.email', 'test@huqan.local']);
  git(['config', 'user.name', 'huqan-test']);
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/notes.md'), 'release v1.0.0 shipped\n', 'utf8');
  git(['add', '-A']);
  git(['commit', '-qm', 'fixture']);
  return root;
}

function docsTask() {
  return {
    id: 'task-untracked-1',
    level: 'l0',
    allowedPaths: ['docs/notes.md'],
    operation: { type: 'replace_text', path: 'docs/notes.md', find: 'v1.0.0', replace: 'v1.1.0' },
  };
}

function writeTask(root, task) {
  const taskFile = path.join(root, 'task.json');
  fs.writeFileSync(taskFile, JSON.stringify(task), 'utf8');
  return taskFile;
}

describe('isRuntimeArtifact', () => {
  it('recognises the runtime persistence family', () => {
    for (const name of ['memory.db', 'memory.db-shm', 'memory.db-wal', 'memory.json', '.route-server-1.db', 'memory.mutations.json.lock', 'x.agent.json', 'test_memory.db']) {
      assert.equal(isRuntimeArtifact(name), true, name);
    }
  });

  it('leaves ordinary source and documents alone', () => {
    for (const name of ['src/index.js', 'task.json', 'docs/notes.md', 'memory.database', 'README.md']) {
      assert.equal(isRuntimeArtifact(name), false, name);
    }
  });

  it('does not treat an unrelated lock file as a runtime artifact', () => {
    assert.equal(isRuntimeArtifact('package-lock.json'), false);
    assert.equal(isRuntimeArtifact('something.lock'), false);
  });
});

describe('partitionUntracked', () => {
  it('drops runtime artifacts and the caller-named file, keeps the rest', () => {
    const root = '/repo';
    const { ignored, remaining } = partitionUntracked(
      ['memory.db', 'memory.db-wal', 'task.json', 'scratch.js'],
      { root, ignoredPaths: ['/repo/task.json'] },
    );
    assert.deepEqual(ignored, ['memory.db', 'memory.db-wal', 'task.json']);
    assert.deepEqual(remaining, ['scratch.js']);
  });
});

describe('readRepoState with runtime artifacts', () => {
  it('a tree carrying only memory.db and the task file is not dirty', () => {
    const root = makeGitRoot();
    fs.writeFileSync(path.join(root, 'memory.db'), 'sqlite', 'utf8');
    fs.writeFileSync(path.join(root, 'memory.db-wal'), 'wal', 'utf8');
    const taskFile = writeTask(root, docsTask());

    const state = readRepoState(root, { ignoredPaths: [taskFile] });
    assert.equal(state.known, true);
    assert.equal(state.hasUntracked, false);
    assert.equal(state.dirty, false);
  });

  it('drops a non-ASCII task file without quoting it', () => {
    // core.quotePath would turn "görev.json" into a quoted, escaped form under
    // the default porcelain output; the caller's own path must still match.
    const root = makeGitRoot();
    const taskFile = path.join(root, 'görev.json');
    fs.writeFileSync(taskFile, JSON.stringify(docsTask()), 'utf8');

    const state = readRepoState(root, { ignoredPaths: [taskFile] });
    assert.equal(state.known, true);
    assert.equal(state.hasUntracked, false);
    assert.deepEqual(state.untrackedPaths, []);
  });

  it('still reports a real untracked file, and names it', () => {
    const root = makeGitRoot();
    fs.writeFileSync(path.join(root, 'memory.db'), 'sqlite', 'utf8');
    fs.writeFileSync(path.join(root, 'scratch.js'), 'console.log(1)\n', 'utf8');

    const state = readRepoState(root, {});
    assert.equal(state.hasUntracked, true);
    assert.deepEqual(state.untrackedPaths, ['scratch.js']);
  });
});

describe('coder end to end on a tree it dirtied itself', () => {
  it('reaches the gate instead of refusing on dirt', () => {
    const root = makeGitRoot();
    fs.writeFileSync(path.join(root, 'memory.db'), 'sqlite', 'utf8');
    const taskFile = writeTask(root, docsTask());

    const response = runCliCoder([taskFile, '--root', root, '--dry-run', '--json'], { json: true });
    assert.equal(response.status, 'completed');
    assert.notEqual(response.data.record.gate.reason, 'DIRTY_REPO_REVIEW_REQUIRED');
  });

  it('prints the untracked file that held the run', () => {
    const root = makeGitRoot();
    fs.writeFileSync(path.join(root, 'memory.db'), 'sqlite', 'utf8');
    fs.writeFileSync(path.join(root, 'scratch.js'), 'console.log(1)\n', 'utf8');
    const taskFile = writeTask(root, docsTask());

    const text = runCliCoder([taskFile, '--root', root, '--dry-run'], {});
    assert.match(text, /DIRTY_REPO_REVIEW_REQUIRED/);
    assert.match(text, /scratch\.js/);
    assert.doesNotMatch(text, /memory\.db\b/);
  });
});
