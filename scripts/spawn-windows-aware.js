'use strict';

/**
 * `spawnSync` for a target that may be a Windows `.cmd` shim.
 *
 * Node refuses to launch a `.cmd` or `.bat` directly since the CVE-2024-27980
 * hardening: the call returns `status: null` with `error.code === 'EINVAL'` and
 * an empty stderr, which reads like a timeout or a crashed child rather than a
 * refusal to start. Every `node_modules/.bin` entry is a `.cmd` on Windows, so
 * any code that launches an installed executable hits this.
 *
 * The fix is to go through the command processor explicitly. `/d` skips
 * AutoRun, `/s` keeps the rest of the line intact, and `/c` runs it -- passing
 * the target as its own argument rather than interpolating it into a string, so
 * no quoting question arises. `shell: true` would also work and is worse: it
 * hands the command line to cmd.exe for parsing.
 *
 * This lived as a byte-identical copy inside scripts/verify-package-tarball.js
 * and scripts/launch-installed-package-smoke.js, and was simply missing from
 * the third caller -- the 4C1 MCP smoke in test/kernel-facade-contract.test.js,
 * which has been failing on Windows for exactly this reason. A platform
 * workaround that is copied rather than shared is one a new call site does not
 * get.
 *
 * @param {string} command executable path, possibly a `.cmd` shim
 * @param {string[]} args
 * @param {object} [options] passed through to spawnSync
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function spawnSyncWindowsAware(command, args = [], options = {}) {
  const cp = require('node:child_process');
  const isWindowsCmd = process.platform === 'win32' && String(command).toLowerCase().endsWith('.cmd');
  if (!isWindowsCmd) return cp.spawnSync(command, args, options);
  // ComSpec is set on every Windows host; falling back keeps this total rather
  // than throwing a TypeError that would look like yet another spawn failure.
  const shell = process.env.ComSpec || 'cmd.exe';
  return cp.spawnSync(shell, ['/d', '/s', '/c', command, ...args], options);
}

module.exports = { spawnSyncWindowsAware };
