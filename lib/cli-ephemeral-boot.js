'use strict';

/**
 * Which commands the CLI may boot without opening the caller's default store.
 *
 * `new CLI()` builds a kernel, and that kernel derives its SQLite file from the
 * working directory when nobody names one. That default is deliberate -- the
 * CLI follows cwd -- but it also means booting the CLI to run a command that
 * never wants the caller's store still creates one. `huqan quickstart` is the
 * worst case: it advertises a throwaway demo and "your own memory was not
 * touched", then leaves a brand-new `memory.db` in the cwd for the user to
 * commit (#3649). `huqan --help` did the same.
 *
 * The fix is not to change the default, which the local-first contract keeps.
 * It is to point the boot kernel at a throwaway store for the commands that do
 * not read or write the caller's -- quickstart builds its own demo store and
 * the help text is static. The redirected store lives under the OS temp
 * directory, so the guard already treats it as ephemeral: it is never
 * registered and never refused, and a machine that already keeps a store
 * elsewhere can still run `huqan quickstart` (which it could not while the
 * boot opened an implicit second store and the guard refused it).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Commands whose boot kernel must not touch the caller's store. Kept to the
 * ones that provably need no store: a command that reads or writes the user's
 * memory keeps the cwd default, and the store-creation guard governs it.
 */
const EPHEMERAL_BOOT_COMMANDS = Object.freeze(new Set([
  'quickstart',
]));

// One directory per process, not per call: an in-process caller may boot more
// than one CLI, and they should not each leave a directory behind. The OS owns
// cleanup under the temp root.
let sharedBootRoot = null;

function ephemeralBootRoot() {
  if (sharedBootRoot === null) {
    sharedBootRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cli-boot-'));
  }
  return sharedBootRoot;
}

/**
 * A kernel options object that points at a throwaway store.
 *
 * @returns {{memoryPath: string, dbPath: string, loadPlugins: boolean}}
 */
function ephemeralKernelOptions() {
  const root = ephemeralBootRoot();
  return {
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
    loadPlugins: false,
  };
}

/**
 * The throwaway kernel options for a command, or null when the command keeps
 * the caller's store.
 *
 * @param {string|undefined} command
 * @returns {object|null}
 */
function resolveEphemeralKernelOptions(command) {
  return EPHEMERAL_BOOT_COMMANDS.has(String(command || '')) ? ephemeralKernelOptions() : null;
}

module.exports = {
  EPHEMERAL_BOOT_COMMANDS,
  ephemeralKernelOptions,
  resolveEphemeralKernelOptions,
};