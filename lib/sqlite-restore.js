'use strict';

/**
 * Windows-safe restore handle management (#1848).
 *
 * Windows cannot rename over an open SQLite file: rename-over-open is
 * POSIX-only, so `fs.renameSync` in `atomicReplaceFile` fails with EPERM on the
 * file `restoreBackup` is replacing. `memory.db` is held open by the graph, the
 * memory store and -- unless a separate dbPath was configured -- agent storage,
 * all of which keep a better-sqlite3 handle on it. The CLI closes those handles
 * before the replacement and reopens them afterwards (then reloads), so restore
 * works for the Windows operator it is meant to rescue. CI is Linux-only, where
 * rename-over-open is legal, which is why the ordering is asserted in the
 * kernel-cli audit contract test rather than left to the platform.
 */

/** True when agent storage holds an open SQLite handle. */
function storageWasOpen(storage) {
  return !!(storage && storage.db && storage.db.open !== false
    && typeof storage.close === 'function');
}

/** Closes the handles that point at the files restore replaces. */
function closeRestoreHandles({ kernel, storage }) {
  if (kernel?.graph && typeof kernel.graph.closeSqlite === 'function') kernel.graph.closeSqlite();
  if (kernel?.memory && typeof kernel.memory.close === 'function') kernel.memory.close();
  if (storageWasOpen(storage)) storage.close();
}

/**
 * Reopens handles previously closed by closeRestoreHandles(). The `wasOpen`
 * flag decides whether agent storage is reopened: a store that was already
 * closed (tests, standalone reads) must not be force-opened, because reopening
 * points the handle at whatever it resolved to and can throw SQLITE_NOTADB.
 */
function reopenRestoreHandles({ kernel, storage, storageOpen }) {
  if (storageOpen && storage && typeof storage.reopen === 'function') storage.reopen();
  if (kernel?.memory && typeof kernel.memory.reopen === 'function') kernel.memory.reopen();
  if (kernel?.graph && typeof kernel.graph.reopen === 'function') kernel.graph.reopen();
}

module.exports = {
  storageWasOpen,
  closeRestoreHandles,
  reopenRestoreHandles,
};