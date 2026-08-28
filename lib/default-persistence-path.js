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

let testRunRoot = null;

/** True while running under `node --test`, which sets NODE_TEST_CONTEXT. */
function isTestRunner() {
  return typeof process.env.NODE_TEST_CONTEXT === 'string' && process.env.NODE_TEST_CONTEXT !== '';
}

function testRunPersistenceRoot() {
  if (testRunRoot === null) {
    const root = path.join(os.tmpdir(), `huqan-test-default-${process.pid}-${Date.now()}`);
    // SQLite opens the database itself but will not create the directory it
    // sits in, so the root has to exist before anything derives a path from it.
    fs.mkdirSync(root, { recursive: true });
    testRunRoot = root;
  }
  return testRunRoot;
}

const REPO_ROOT = path.resolve(__dirname, '..');

function isInsideRepo(candidate) {
  const relative = path.relative(REPO_ROOT, path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** The persistence path to use when the caller supplied none. */
function resolveDefaultMemoryPath() {
  if (!isTestRunner()) return DEFAULT_MEMORY_FILENAME;
  if (!isInsideRepo(path.resolve(process.cwd(), DEFAULT_MEMORY_FILENAME))) return DEFAULT_MEMORY_FILENAME;
  return path.join(testRunPersistenceRoot(), DEFAULT_MEMORY_FILENAME);
}

module.exports = {
  DEFAULT_MEMORY_FILENAME,
  isInsideRepo,
  isTestRunner,
  resolveDefaultMemoryPath,
  testRunPersistenceRoot,
};
