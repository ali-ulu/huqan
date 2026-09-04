'use strict';

/**
 * A throwaway gate state root for the duration of a test run.
 *
 * The external-action gate keeps its state -- the receipt trail and the command
 * policy beside it -- outside the repository, under `%LOCALAPPDATA%\huqan` (or
 * `~/.local/state/huqan`). A suite run on a developer machine therefore read
 * the operator's real policy and appended to their real receipt chain: a test's
 * synthetic `block` landed in the trail that is supposed to be the auditable
 * record of real refusals, and a test's verdict depended on how that developer
 * had configured their own gate (#1846). CI never saw either, because runners
 * start clean and the files are sharded, so the polluting order never formed.
 *
 * Every run therefore gets its own temporary state root, and the runner points
 * the whole suite at it. The narrower per-file overrides are dropped from the
 * child environment as well: a variable exported in the developer's shell would
 * otherwise aim the suite straight back at the real trail, which is the case
 * this exists to make impossible. A test that wants a specific path still sets
 * either variable for itself -- both still win over the state root.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Create the sandbox: a fresh state root, the environment a test process should
 * inherit, and the cleanup that removes it. Cleanup is idempotent and also runs
 * on process exit, so a runner that waits on an asynchronous child cannot leave
 * the directory behind.
 */
function createTestStateSandbox(baseEnvironment = process.env) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-test-state-'));
  const environment = { ...baseEnvironment, HUQAN_STATE_ROOT: stateRoot };
  delete environment.HUQAN_EXTERNAL_GUARD_RECEIPTS;
  delete environment.HUQAN_EXTERNAL_GUARD_POLICY;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    fs.rmSync(stateRoot, { recursive: true, force: true });
  };
  process.on('exit', cleanup);
  return Object.freeze({ environment, stateRoot, cleanup });
}

module.exports = { createTestStateSandbox };
