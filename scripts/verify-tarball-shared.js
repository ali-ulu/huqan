'use strict';

// #2230: shared tarball-verification primitives extracted from
// scripts/verify-package-tarball.js. One job: failure verdicts, child-process
// runs, platform bin paths. No verification logic, no install orchestration.

const { spawnSyncWindowsAware } = require('./spawn-windows-aware');

const repoRoot = require('node:path').resolve(__dirname, '..');
const pkg = JSON.parse(require('node:fs').readFileSync(require('node:path').join(repoRoot, 'package.json'), 'utf8'));
// npm and package bins are .cmd files on Windows.  PowerShell resolves their
// extension interactively, but child_process does not add it for us.
const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function packageBin(binDir, name) {
  return require('node:path').join(binDir, process.platform === 'win32' ? `${name}.cmd` : name);
}

/** Output that means a module did not load, whatever the exit code said. */
const LOAD_FAILURE_PATTERNS = [
  /Plugin failed to load/i,
  /Cannot find module/i,
  /MODULE_NOT_FOUND/,
];

const failures = [];

function fail(message) {
  failures.push(message);
  console.error(`FAIL: ${message}`);
}

/**
 * Hand the failures recorded by the shared verifiers below to another
 * script. verify-published-round-trip.js (#2631) reuses these verifiers but
 * owns its own verdict, so it drains this list after each consumer instead
 * of sharing the exit code. The messages were already printed once by
 * fail(); the drained strings must be recorded silently.
 */
function takeSharedFailures() {
  return failures.splice(0, failures.length);
}

function ok(message) {
  console.log(`  ok: ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSyncWindowsAware(command, args, {
    encoding: 'utf8',
    timeout: options.timeoutMs || 10 * 60 * 1000,
    ...options,
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    output: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

module.exports = {
  LOAD_FAILURE_PATTERNS,
  NPM_COMMAND,
  packageBin,
  run,
  takeSharedFailures,
  ok,
  fail,
  failures,
  pkg,
  repoRoot,
};
