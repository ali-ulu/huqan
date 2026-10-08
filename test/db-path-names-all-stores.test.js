'use strict';

/**
 * #3669: naming a store directory with an environment variable must move every
 * store defaulted beside it, not just the graph.
 *
 * The bug: `HUQAN_DB_PATH` named the graph's file, but the memory store and the
 * agent store still derived their defaults from the working directory, so one
 * variable produced stores in two directories. The guard that refuses a stray
 * `memory.db` also missed it, because it read "some store was named" as "this
 * store was named".
 *
 * The CLI is exercised as a subprocess because that is the surface the operator
 * runs, and the file layout after the process exits is the observable.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  DEFAULT_MEMORY_FILENAME,
  environmentStoreDirectory,
  resolveDefaultMemoryPath,
  testRunPersistenceRoot,
} = require('../lib/default-persistence-path');
const { environmentNamesStoreDirectory } = require('../lib/sqlite-persistence-validation');

const CLI_PATH = path.join(__dirname, '..', 'cli.js');

describe('a named store directory owns its defaulted companions (#3669)', { concurrency: false }, () => {
  it('environmentStoreDirectory resolves the directory the environment named', () => {
    // Built with path.join so the expectation matches on every platform.
    const named = path.join(path.sep, 'srv', 'huqan', 'named');
    const other = path.join(path.sep, 'srv', 'other');
    assert.equal(
      environmentStoreDirectory({ HUQAN_DB_PATH: path.join(named, 'graph.db') }),
      named,
    );
    assert.equal(
      environmentStoreDirectory({ AXIOM_MEMORY_PATH: path.join(other, 'memory.json') }),
      other,
    );
  });

  it('an empty or absent variable names no directory, so cwd stays the default', () => {
    assert.equal(environmentStoreDirectory({}), null);
    assert.equal(environmentStoreDirectory({ HUQAN_DB_PATH: '   ' }), null);
    // No variable means the default is unchanged: the test runner's per-run
    // redirect still applies (arch-default-persistence-isolation.contract.test.js
    // asserts that directly), and a plain environment keeps cwd semantics.
    assert.equal(resolveDefaultMemoryPath({}), path.join(testRunPersistenceRoot(), DEFAULT_MEMORY_FILENAME));
  });

  it('a named directory wins over the test-runner redirect, an explicit choice', () => {
    const named = path.join(path.sep, 'srv', 'huqan', 'named');
    assert.equal(
      resolveDefaultMemoryPath({ HUQAN_DB_PATH: path.join(named, 'graph.db') }),
      path.join(named, 'memory.json'),
    );
  });

  it('environmentNamesStoreDirectory only flags stores in the named directory', () => {
    const named = path.join(path.sep, 'srv', 'huqan', 'named');
    const elsewhere = path.join(path.sep, 'work', 'project');
    const environment = { HUQAN_DB_PATH: path.join(named, 'graph.db') };
    // The graph's own file, and a companion defaulted beside it, are both named.
    assert.equal(environmentNamesStoreDirectory(path.join(named, 'graph.db'), environment), true);
    assert.equal(environmentNamesStoreDirectory(path.join(named, 'memory.db'), environment), true);
    // A store in the working directory is not, so the guard still refuses it.
    assert.equal(environmentNamesStoreDirectory(path.join(elsewhere, 'memory.db'), environment), false);
    // A JSON memory path names the SQLite store beside it.
    assert.equal(
      environmentNamesStoreDirectory(path.join(named, 'memory.db'), { HUQAN_MEMORY_PATH: path.join(named, 'memory.json') }),
      true,
    );
  });

  // Run against a directory outside os.tmpdir(), because the guard exempts the
  // temp root as a throwaway -- a stray would go unnoticed there.
  function keptDir(label) {
    return fs.mkdtempSync(path.join(os.homedir(), `huqan-3669-${label}-`));
  }

  function runCli(args, { cwd, environment }) {
    // The test runner redirects the implicit default into its own per-run temp
    // root, so a spawned CLI that is still marked as a runner would not exercise
    // the local-first default these cases are about. Clear the marker: the child
    // is a plain operator process.
    const env = Object.assign({}, process.env, environment, { NODE_TEST_CONTEXT: '' });
    return spawnSync(process.execPath, [CLI_PATH, ...args], {
      cwd,
      env,
      input: '',
      encoding: 'utf8',
      timeout: 30000,
    });
  }

  it('HUQAN_DB_PATH puts graph.db and memory.db in the named directory, not cwd', () => {
    const root = keptDir('named');
    const cwd = path.join(root, 'cwd');
    const named = path.join(root, 'named');
    fs.mkdirSync(cwd);
    fs.mkdirSync(named);
    try {
      const result = runCli(['durum'], {
        cwd,
        environment: { HUQAN_DB_PATH: path.join(named, 'graph.db'), HUQAN_STATE_ROOT: path.join(root, 'state') },
      });
      assert.equal(result.status, 0, result.stderr);
      // The named directory holds both stores; the working directory holds none.
      assert.deepEqual(fs.readdirSync(named).sort(), ['graph.db', 'memory.db']);
      assert.deepEqual(fs.readdirSync(cwd), [], 'the working directory was written to');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('with a store already registered, a stray cwd store is still refused', () => {
    const root = keptDir('guard');
    const state = path.join(root, 'state');
    const seed = path.join(root, 'seed');
    const fresh = path.join(root, 'fresh');
    fs.mkdirSync(seed);
    fs.mkdirSync(fresh);
    try {
      // Register one store, so the machine is past the first-install exemption.
      const seeded = runCli(['durum'], { cwd: seed, environment: { HUQAN_STATE_ROOT: state } });
      assert.equal(seeded.status, 0, seeded.stderr);

      const refused = runCli(['durum'], { cwd: fresh, environment: { HUQAN_STATE_ROOT: state } });
      assert.match(refused.stdout + refused.stderr, /refusing to create a new store at an unnamed path/);
      assert.deepEqual(fs.readdirSync(fresh), [], 'a stray store was created in the working directory');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
