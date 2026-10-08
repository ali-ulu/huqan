'use strict';

/**
 * #3649 — `huqan quickstart` must not leave a store in the caller's directory.
 *
 * The command advertises a throwaway demo and prints "your own memory was not
 * touched", but booting the CLI built a kernel whose store defaults to the
 * working directory, and the first such store on a machine was created as a
 * side effect. The run therefore left a brand-new `memory.db` beside the user
 * and, once any store was registered, a later run from another directory was
 * refused outright ("refusing to create a new store at an unnamed path") — a
 * new user's first command failing on a machine that had ever run HUQAN.
 *
 * The fix boots only the store-free commands (`quickstart`, `--help`) against
 * a throwaway store under the OS temp root, and leaves the local-first cwd
 * default untouched for everything else. These tests spawn the real CLI,
 * because the defect lived in the boot path a unit test would stub away.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (err) {
    if (!['EPERM', 'EBUSY'].includes(err?.code)) throw err;
  }
}

/**
 * Run the real CLI in `cwd`, with a caller-owned state root so the store
 * registry is whatever the test wrote and nothing ambient leaks in.
 */
function runCli(args, { cwd, stateRoot }) {
  return spawnSync(process.execPath, [path.join(repoRoot, 'cli.js'), ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HUQAN_STATE_ROOT: stateRoot, HUQAN_ALLOW_NEW_STORE: '' },
  });
}

function writeRegistry(stateRoot, entries) {
  fs.writeFileSync(path.join(stateRoot, 'stores.json'), `${JSON.stringify(entries, null, 2)}\n`);
}

test('quickstart leaves no memory.db in the working directory', () => {
  const cwd = makeTempDir('huqan-3649-fresh-cwd-');
  const stateRoot = makeTempDir('huqan-3649-fresh-state-');
  try {
    writeRegistry(stateRoot, []);
    const result = runCli(['quickstart'], { cwd, stateRoot });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Trust Receipt/);
    assert.match(result.stdout, /throwaway/);
    // The whole point: the caller's directory is untouched.
    assert.equal(fs.existsSync(path.join(cwd, 'memory.db')), false);
    assert.deepEqual(fs.readdirSync(cwd), []);
  } finally {
    removeTempDir(cwd);
    removeTempDir(stateRoot);
  }
});

test('quickstart runs even when this machine already keeps a store elsewhere', () => {
  const cwd = makeTempDir('huqan-3649-known-cwd-');
  const stateRoot = makeTempDir('huqan-3649-known-state-');
  try {
    // A registered store makes an implicit second store a refusal; quickstart
    // must not need one now that it boots against a throwaway store.
    writeRegistry(stateRoot, [path.join(os.homedir(), 'elsewhere', 'memory.db')]);
    const result = runCli(['quickstart'], { cwd, stateRoot });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Trust Receipt/);
    assert.doesNotMatch(result.stderr, /refusing to create a new store/);
    assert.equal(fs.existsSync(path.join(cwd, 'memory.db')), false);
    // The registry still names only the caller's real store.
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateRoot, 'stores.json'), 'utf8')),
      [path.join(os.homedir(), 'elsewhere', 'memory.db')]);
  } finally {
    removeTempDir(cwd);
    removeTempDir(stateRoot);
  }
});

test('--help leaves no memory.db in the working directory', () => {
  const cwd = makeTempDir('huqan-3649-help-cwd-');
  const stateRoot = makeTempDir('huqan-3649-help-state-');
  try {
    writeRegistry(stateRoot, [path.join(os.homedir(), 'elsewhere', 'memory.db')]);
    const result = runCli(['--help'], { cwd, stateRoot });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /HUQAN commands:/);
    assert.equal(fs.existsSync(path.join(cwd, 'memory.db')), false);
  } finally {
    removeTempDir(cwd);
    removeTempDir(stateRoot);
  }
});

test('the cwd default still holds for a command that keeps a store', () => {
  const cwd = makeTempDir('huqan-3649-cwd-default-');
  const stateRoot = makeTempDir('huqan-3649-cwd-default-state-');
  try {
    // Empty registry: the local-first default creates the caller's store, as
    // it always did. Only the store-free commands are redirected.
    writeRegistry(stateRoot, []);
    const result = runCli(['status'], { cwd, stateRoot });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(cwd, 'memory.db')), true);
  } finally {
    removeTempDir(cwd);
    removeTempDir(stateRoot);
  }
});