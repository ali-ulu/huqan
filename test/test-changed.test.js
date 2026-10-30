'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');

const {
  buildRunnerArgs,
  collectChangedFiles,
  defaultBase,
  main,
  parseArgs,
} = require('../scripts/test-changed');

const REPO_ROOT = path.join(__dirname, '..');

/** A throwaway git repository with one committed test file. */
function scratchRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-test-changed-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  // The default branch name depends on the host git config; pin it so the
  // `main` fallback in defaultBase is exercised deterministically.
  git('symbolic-ref', 'HEAD', 'refs/heads/main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(path.join(root, 'lib.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(root, 'test', 'sample.test.js'), "require('node:test')('x', () => {});\n");
  git('add', '.');
  git('commit', '-qm', 'init');
  return { root, git };
}

test('changed-file collection includes uncommitted, staged and untracked files', () => {
  const { root } = scratchRepo();
  try {
    // Committed change on a branch.
    fs.writeFileSync(path.join(root, 'lib.js'), 'module.exports = 2;\n');
    execFileSync('git', ['commit', '-qam', 'change'], { cwd: root, stdio: 'pipe' });
    // Unstaged edit.
    fs.writeFileSync(path.join(root, 'test', 'sample.test.js'), "require('node:test')('y', () => {});\n");
    // Untracked file.
    fs.writeFileSync(path.join(root, 'brand-new.js'), 'module.exports = 3;\n');

    const files = collectChangedFiles({ root, base: 'HEAD~1' });
    assert.ok(files.includes('lib.js'), 'committed change must appear');
    assert.ok(files.includes('test/sample.test.js'), 'unstaged edit must appear');
    assert.ok(files.includes('brand-new.js'), 'untracked file must appear');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a base that is behind HEAD still reports only the branch change, not the base tip', () => {
  const { root } = scratchRepo();
  try {
    fs.writeFileSync(path.join(root, 'lib.js'), 'module.exports = 2;\n');
    execFileSync('git', ['commit', '-qam', 'branch change'], { cwd: root, stdio: 'pipe' });
    const files = collectChangedFiles({ root, base: 'HEAD~1' });
    assert.deepEqual(files, ['lib.js']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runner arguments pin concurrency and forward the selected files verbatim', () => {
  assert.deepEqual(buildRunnerArgs({ files: ['test/a.test.js'], concurrency: 4 }), [
    '--test-concurrency=4',
    'test/a.test.js',
  ]);
  // Empty files means "run everything": run-tests.js forwards no paths to node.
  assert.deepEqual(buildRunnerArgs({ files: [], concurrency: 2 }), ['--test-concurrency=2']);
});

test('argument parsing rejects an unknown flag and a non-positive concurrency', () => {
  assert.deepEqual(parseArgs([]), { base: null, concurrency: 4, dryRun: false });
  assert.deepEqual(parseArgs(['--base=main', '--concurrency=8', '--dry-run']), {
    base: 'main', concurrency: 8, dryRun: true,
  });
  assert.throws(() => parseArgs(['--nope']), /unsupported argument/);
  assert.throws(() => parseArgs(['--concurrency=0']), /positive integer/);
});

test('defaultBase prefers origin/main and falls back to main', () => {
  const { root } = scratchRepo();
  try {
    assert.equal(defaultBase(root), 'main');
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: root, stdio: 'pipe' });
    assert.equal(defaultBase(root), 'origin/main');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a runtime change runs the selected tests through the runner, not the whole suite', async () => {
  const { root } = scratchRepo();
  try {
    fs.writeFileSync(path.join(root, 'lib.js'), 'module.exports = 2;\n');
    fs.writeFileSync(path.join(root, 'test', 'sample.test.js'), "require('node:test')('y', () => {});\n");
    const lines = [];
    let invocation = null;
    const code = await main(['--base=HEAD'], {
      root,
      log: (line) => lines.push(line),
      run: async (options) => { invocation = options; return 0; },
    });
    assert.equal(code, 0);
    assert.ok(invocation, 'the runner must be started for a runtime change');
    assert.deepEqual(invocation.files, ['test/sample.test.js']);
    assert.ok(lines.some((line) => /1 test file\(s\)/.test(line)), `expected a selection line, got: ${lines.join(' | ')}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a docs-only change runs nothing and never starts the runner', async () => {
  const { root } = scratchRepo();
  try {
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs', 'guide.md'), '# guide\n');
    const lines = [];
    let ran = false;
    const code = await main(['--base=HEAD'], {
      root,
      log: (line) => lines.push(line),
      run: async () => { ran = true; return 0; },
    });
    assert.equal(code, 0);
    assert.equal(ran, false, 'a docs-only change must not start the runner');
    assert.ok(lines.some((line) => /nothing to run/.test(line)), `expected a no-op line, got: ${lines.join(' | ')}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--dry-run lists the selection without starting the runner', async () => {
  const { root } = scratchRepo();
  try {
    fs.writeFileSync(path.join(root, 'lib.js'), 'module.exports = 2;\n');
    fs.writeFileSync(path.join(root, 'test', 'sample.test.js'), "require('node:test')('y', () => {});\n");
    const lines = [];
    let ran = false;
    const code = await main(['--base=HEAD', '--dry-run'], {
      root,
      log: (line) => lines.push(line),
      run: async () => { ran = true; return 0; },
    });
    assert.equal(code, 0);
    assert.equal(ran, false, '--dry-run must not start the runner');
    assert.ok(lines.includes('  test/sample.test.js'), `expected the file in dry-run output, got: ${lines.join(' | ')}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
