'use strict';

/**
 * Refuses to bring a *new* store into existence at a path nobody named.
 *
 * `resolveDefaultMemoryPath()` returns a bare `memory.json`, so a process that
 * names no path derives `memory.db` from its working directory. That default is
 * deliberate and stays: it is how the CLI follows cwd, and cli.test.js asserts
 * it. What it also does is create a brand-new, empty store the first time any
 * process happens to run from a directory that has none -- and an empty store
 * is indistinguishable, from the outside, from a real one that lost its data.
 *
 * On this operator's machine that happened: the external-action gate runs from
 * whatever directory an agent session is in, and one of those runs left a
 * `memory.db` in `%LOCALAPPDATA%\huqan` holding eighteen approvals, no graph,
 * and no audit events. Nothing referenced it, nothing read it, and it looked
 * exactly like a store whose audit log had been emptied.
 *
 * So the guard is narrow on purpose. Opening a store that already exists is
 * untouched -- that is the common path and the one tests rely on. Only the
 * combination that produces a stray is refused: an implicit path, and no file
 * there yet. The refusal names the stores this machine already knows about, so
 * a caller that was trying to reinstall is told where the real one is instead
 * of quietly getting a nineteenth empty database.
 *
 * Rebuild is the one way through, and it must be asked for by name
 * (`HUQAN_ALLOW_NEW_STORE`): creating a fresh store is a legitimate operation,
 * it is just never something that should happen as a side effect.
 */

const fs = require('node:fs');
const path = require('node:path');

const { isTestRunner } = require('./default-persistence-path');
const { defaultStateRoot } = require('./huqan-state-root');

/** Values that count as "yes" for the rebuild opt-in. */
const REBUILD_OPT_IN_VALUES = Object.freeze(new Set(['1', 'true', 'yes', 'on']));

const REBUILD_OPT_IN_VARIABLE = 'HUQAN_ALLOW_NEW_STORE';

/**
 * How many store paths the registry keeps. The registry exists to answer
 * "where are my stores", which a handful of paths does; it is not a log.
 */
const MAX_REGISTERED_STORES = 32;

const STORE_CREATION_REFUSED_CODE = 'HUQAN_IMPLICIT_STORE_CREATION_REFUSED';

function registryPath(environment = process.env) {
  return path.join(defaultStateRoot(environment), 'stores.json');
}

/**
 * Every store path this machine has opened, most recent last. Unreadable or
 * malformed registries read as empty: the registry is a convenience for the
 * refusal message, so it must never be the reason a store fails to open.
 */
function readKnownStores(environment = process.env) {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath(environment), 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry) => typeof entry === 'string' && entry.trim());
  } catch (_) {
    return [];
  }
}

/**
 * Record a store path as known. Called after a successful open, including the
 * first open of a store that was created with the rebuild opt-in, so the next
 * refusal can name it.
 *
 * Best-effort by design: a read-only state root is not a reason to fail an
 * open that has otherwise succeeded.
 */
function recordKnownStore(dbPath, environment = process.env) {
  // Suite stores are per-run throwaways, so registering them would bury the
  // operator's real paths under temporary ones and write on every construction.
  if (isTestRunner()) return false;
  const resolved = path.resolve(dbPath);
  const existing = readKnownStores(environment);
  // Already the most recent entry: the file would not change, and a graph is
  // constructed often enough that an unconditional write is worth avoiding.
  if (existing[existing.length - 1] === resolved) return true;
  const bounded = [...existing.filter((entry) => entry !== resolved), resolved]
    .slice(-MAX_REGISTERED_STORES);
  try {
    const target = registryPath(environment);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, `${JSON.stringify(bounded, null, 2)}\n`, { mode: 0o600 });
    return true;
  } catch (_) {
    return false;
  }
}

function isRebuildAllowed(environment = process.env) {
  const raw = environment[REBUILD_OPT_IN_VARIABLE];
  return REBUILD_OPT_IN_VALUES.has(String(raw ?? '').trim().toLowerCase());
}

function refusalMessage(dbPath, known) {
  const lines = [
    `refusing to create a new store at an unnamed path: ${path.resolve(dbPath)}`,
    'this path was derived from the working directory, not requested, and no store exists there yet.',
  ];
  if (known.length) {
    lines.push('this machine already has a store here:');
    for (const entry of known) lines.push(`  ${entry}`);
    lines.push('point HUQAN_DB_PATH at the one you meant.');
  } else {
    lines.push('set HUQAN_DB_PATH to the store you meant to open.');
  }
  lines.push(`to create a new store on purpose, set ${REBUILD_OPT_IN_VARIABLE}=1.`);
  return lines.join('\n');
}

/**
 * Throw unless this store may be brought into existence.
 *
 * Permitting an open also registers the path. That happens before the open
 * rather than after it because the fact being recorded -- this machine keeps a
 * store here -- is settled by the decision, not by whether SQLite then
 * succeeds; and it keeps the caller down to one line, which the line budget on
 * graph.js (issue #328) requires.
 *
 * @param {object} params
 * @param {string} params.dbPath        the resolved database path
 * @param {boolean} params.explicit     whether a caller named the path
 * @param {boolean} params.exists       whether the file is already there
 * @param {object} [params.environment]
 * @throws {Error} with code HUQAN_IMPLICIT_STORE_CREATION_REFUSED
 */
function assertStoreCreationAllowed({ dbPath, explicit, exists, environment = process.env }) {
  // A machine with no store yet cannot have a stray: "you already have one
  // here" is the whole content of the refusal, and there is nothing to say. A
  // fresh install is exactly this case -- `huqan quickstart` is a new user's
  // first command and runs in a directory that by definition has no store, so
  // guarding it would break first run to prevent a confusion that cannot
  // happen yet. Once the first store is registered, every later implicit
  // creation is refused.
  //
  // If the registry is unwritable the guard therefore stays open. That is the
  // behaviour before this guard existed, which is the right way for it to fail:
  // a store registry that cannot be kept is not a reason to refuse work.
  const firstStoreOnThisMachine = readKnownStores(environment).length === 0;
  // The runner already redirects the implicit default into a per-run temporary
  // root (#1579), so every suite store is a deliberate throwaway, not a stray.
  if (exists || explicit || firstStoreOnThisMachine
    || isRebuildAllowed(environment) || isTestRunner()) {
    recordKnownStore(dbPath, environment);
    return;
  }

  const error = new Error(refusalMessage(dbPath, readKnownStores(environment)));
  error.code = STORE_CREATION_REFUSED_CODE;
  error.dbPath = path.resolve(dbPath);
  throw error;
}

module.exports = {
  MAX_REGISTERED_STORES,
  REBUILD_OPT_IN_VARIABLE,
  STORE_CREATION_REFUSED_CODE,
  assertStoreCreationAllowed,
  isRebuildAllowed,
  readKnownStores,
  recordKnownStore,
  registryPath,
};
