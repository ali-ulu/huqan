'use strict';

/**
 * What `MemoryStore.save()` and `.load()` report about durability.
 *
 * MemoryStore is opt-in to SQLite (`useSQLite === true`) while Graph, in the
 * same Kernel, is opt-out (`useSQLite !== false`). kernel.js forwards
 * `useSQLite: opts.useSQLite`, which is `undefined` in normal use, so the two
 * storage layers in one kernel ended up with opposite defaults: the graph
 * persisted and the memory core did not. `memoryStoreUseSQLite` is passed from
 * tests only, so a memory core without an explicit SQLite choice remains
 * ephemeral unless its caller selects JSON with `useSQLite: false` and a
 * `memoryPath`.
 *
 * `save()` answered `ok: true` regardless. `skipped: true` was the only
 * signal, and every caller that checks `.ok` — the ordinary way to read this
 * envelope — was told the records were durable when the process was about to
 * drop them. That is silent data loss, so the memory backend now fails closed
 * and names why (#1028).
 *
 * Whether the memory core should persist by default is a separate question
 * this module does not answer; it only makes the current answer visible.
 */

const PERSISTENCE_DISABLED = 'PERSISTENCE_DISABLED';

/**
 * @param {object|null} db the SQLite handle, or null when there is none
 * @param {string|null} jsonPath the JSON backend path, or null when disabled
 * @returns {{ok: boolean, skipped: boolean, persistent: boolean, backend: string, error?: object}}
 */
function saveResult(db, jsonPath = null) {
  if (db) return { ok: true, skipped: true, persistent: true, backend: 'sqlite' };
  if (jsonPath) return { ok: true, skipped: false, persistent: true, backend: 'json' };
  return {
    ok: false,
    skipped: true,
    persistent: false,
    backend: 'memory',
    error: {
      code: PERSISTENCE_DISABLED,
      message: 'MemoryStore has no durable backend: records live in this process only '
        + 'and are lost on exit. Construct it with memoryStoreUseSQLite: true or provide a memoryPath to persist.',
    },
  };
}

/**
 * Loading nothing from nowhere genuinely succeeded — nothing was ever written,
 * so nothing is missing — but `persistent` lets a caller tell that apart from a
 * load that had a backend behind it.
 *
 * @param {object|null} db the SQLite handle, or null when there is none
 * @param {string|null} jsonPath the JSON backend path, or null when disabled
 * @param {number} loaded records currently held in the process
 */
function loadResult(db, jsonPath = null, loaded) {
  return {
    ok: true,
    skipped: !jsonPath,
    persistent: Boolean(db || jsonPath),
    loaded,
    backend: db ? 'sqlite' : (jsonPath ? 'json' : 'memory'),
  };
}

module.exports = { PERSISTENCE_DISABLED, saveResult, loadResult };
