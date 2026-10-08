/**
 * Where persistence lands when the caller names no path.
 *
 * Outside the test runner this is `memory.json` in the working directory --
 * the local-first default HUQAN has always had.
 *
 * Under `node --test` it is a per-run temporary directory instead, because the
 * repository root is shared by the whole suite and sharing it has bitten us
 * three ways (#1579):
 *
 *   - Cross-file pollution. `test/pre-site-refusal-survives-audit-failure.js`
 *     asserts a refused write left no node behind. Another test writing a node
 *     called `n1` into the shared root store made that fail-closed assertion
 *     red with nothing wrong in the code -- a security gate crying wolf.
 *   - Unbounded growth. The shared mutation journal accumulates across runs;
 *     at 15 MB a single learn cost 782 ms against 4 ms isolated.
 *   - Leftovers in the working tree between runs.
 *
 * `noLoad: true` does not avoid any of this: it skips the read, not the write.
 *
 * Per run rather than per file: constructions inside one test file still share
 * a store, which some tests rely on, while separate runs never do. Nothing is
 * cleaned up here -- the OS temp directory owns that -- so a failing test's
 * state is still there to inspect.
 *
 * The redirect applies only when the default would land inside this repository.
 * A test that has already moved itself into an isolated working directory is
 * doing the right thing and keeps cwd semantics: the CLI's default must follow
 * cwd, and cli.test.js asserts exactly that.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_MEMORY_FILENAME = 'memory.json';

/**
 * The environment variables an operator can use to name a store path.
 *
 * Kept here as literals rather than read through `environment-compat`, because
 * this module is a require-cycle leaf: both sides of the graph/persistence
 * cycle depend on it downward, and it may require nothing but node builtins.
 */
const STORE_PATH_VARIABLES = Object.freeze([
  'HUQAN_DB_PATH', 'AXIOM_DB_PATH', 'HUQAN_MEMORY_PATH', 'AXIOM_MEMORY_PATH',
]);

/**
 * The directory named by a store-path environment variable, or null.
 *
 * `HUQAN_DB_PATH=/srv/huqan/graph.db` names the directory `/srv/huqan`, and a
 * store defaulted beside it belongs there -- not in whatever directory the
 * process happens to run from. Before this, the graph moved to the named path
 * while the memory and agent stores stayed in the working directory, so one
 * variable produced two stores that drifted apart (#3669).
 */
function environmentStoreDirectory(environment = process.env) {
  for (const name of STORE_PATH_VARIABLES) {
    const value = typeof environment[name] === 'string' ? environment[name].trim() : '';
    if (value) return path.dirname(path.resolve(value));
  }
  return null;
}

let testRunRoot = null;

/** True while running under `node --test`, which sets NODE_TEST_CONTEXT. */
function isTestRunner() {
  return typeof process.env.NODE_TEST_CONTEXT === 'string' && process.env.NODE_TEST_CONTEXT !== '';
}

function testRunPersistenceRoot() {
  if (testRunRoot === null) {
    testRunRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-test-default-'));
  }
  return testRunRoot;
}

const REPO_ROOT = path.resolve(__dirname, '..');

function isInsideRepo(candidate) {
  const relative = path.relative(REPO_ROOT, path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** The persistence path to use when the caller supplied none. */
function resolveDefaultMemoryPath(environment = process.env) {
  if (isTestRunner()) {
    if (!isInsideRepo(path.resolve(process.cwd(), DEFAULT_MEMORY_FILENAME))) return DEFAULT_MEMORY_FILENAME;
    return path.join(testRunPersistenceRoot(), DEFAULT_MEMORY_FILENAME);
  }
  // An operator who named a store directory means that directory for the
  // stores they did not name individually (#3669). Absolute, so every caller
  // that derives a sibling paths from its directory co-locates rather than
  // reaching for the working directory.
  const named = environmentStoreDirectory(environment);
  if (named) return path.join(named, DEFAULT_MEMORY_FILENAME);
  return DEFAULT_MEMORY_FILENAME;
}

module.exports = {
  DEFAULT_MEMORY_FILENAME,
  STORE_PATH_VARIABLES,
  environmentStoreDirectory,
  isInsideRepo,
  isTestRunner,
  resolveDefaultMemoryPath,
  testRunPersistenceRoot,
};
