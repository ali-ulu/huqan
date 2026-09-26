'use strict';

/**
 * The Experience journal's own SQLite connection, at EVIDENCE durability (#2915).
 *
 * ## Why a second connection to a file that is already open
 *
 * `synchronous` is a per-connection setting, so the durability class is a
 * property of the *handle*, not of the database file. The runtime already
 * relies on this: `graph.js` opens `memory.db` at EVIDENCE and `storage.js`
 * opens the same file at RESUMABLE, at the same time, in every process. Two
 * connections, two classes, one file is the established shape here, not a new
 * one -- `lib/memory-store.js` does the same for `memory_events`.
 *
 * The journal needs its own handle because it cannot borrow either:
 *
 * - `storage.db` is RESUMABLE by a recorded choice. Checkpoints resume from an
 *   earlier point after a power cut and that trade is deliberate; raising the
 *   whole connection to EVIDENCE to serve the journal would fsync every
 *   checkpoint too, and checkpoints are written once per step on the same hot
 *   path. Measured: +1.3 ms per checkpoint, on a path that never asked for it.
 * - The graph's connection is EVIDENCE but belongs to the graph. Taking it
 *   would make Experience a projection of the graph's handle, which is exactly
 *   the coupling `journal.js` refuses (DIP #2118 -- the journal never
 *   constructs or borrows a store it does not own).
 *
 * So the journal owns one handle, at the class its guarantee requires.
 *
 * ## Why EVIDENCE and not RESUMABLE
 *
 * `lib/sqlite-durability.js` reserves EVIDENCE for "the store holds the audit
 * record, and losing its tail loses the record itself with nothing anywhere
 * showing a gap". The journal is that store: it is the learning-history
 * authority, an acknowledged append is what `manifest()` later reports as
 * history, and nothing re-derives it. Under RESUMABLE a commit can return
 * successfully and still be lost on a power cut, leaving a run whose events
 * stop mid-sequence with no gap marker -- the silent-truncation failure the
 * durability policy exists to prevent. The measured cost of closing that hole
 * is in the EVIDENCE list in `lib/sqlite-durability.js`.
 *
 * ## Shape
 *
 * The returned object is store-shaped (`{ withTransaction, db }`), which is the
 * seam `createExperienceJournal` already accepts. The journal therefore needs
 * no knowledge of connections: it is handed a store, as it always was, and the
 * difference between this store and `HuqanStorage` is only which class it is
 * in. That is what keeps the change a store decision rather than a journal
 * rewrite.
 *
 * The table is not created here. `journal.js` owns its schema; this module owns
 * the handle and the class, and nothing else.
 */

const path = require('node:path');
const { loadSqliteDriver, sqliteUnavailableError } = require('../sqlite-availability');
const { applySqliteDurability } = require('../sqlite-durability');
const { resolveBusyRetryConfig } = require('../memory-store-utils');

/**
 * `:memory:` cannot be shared between connections -- a second handle gets a
 * second, empty database -- so it is refused by name rather than opened into a
 * silently separate journal that would look like it worked.
 */
function isSharedableDbPath(dbPath) {
  if (typeof dbPath !== 'string' || !dbPath.trim()) return false;
  return dbPath.trim() !== ':memory:' && !dbPath.trim().startsWith('file::memory:');
}

/**
 * Open the journal's EVIDENCE handle at `dbPath`.
 *
 * Returns `null` when no shared path is available, so a caller keeps the
 * injected-store path instead of failing: a journal with no own connection is
 * the pre-#2915 state, not an error.
 *
 * @param {{dbPath?: string, busyTimeoutMs?: number}} [opts]
 * @returns {{withTransaction: function, db: object, dbPath: string, close: function, reopen: function}|null}
 */
function openJournalConnection(opts = {}) {
  const dbPath = typeof opts.dbPath === 'string' ? opts.dbPath : '';
  if (!isSharedableDbPath(dbPath)) return null;
  const { Database, loadError } = loadSqliteDriver();
  if (!Database) throw sqliteUnavailableError('better-sqlite3 is required for the Experience journal.', loadError);
  const resolved = path.resolve(dbPath.trim());
  const busyTimeoutMs = resolveBusyRetryConfig(
    Number.isFinite(opts.busyTimeoutMs) ? { busyTimeoutMs: opts.busyTimeoutMs } : {},
  ).busyTimeoutMs;

  let db = null;

  const open = () => {
    db = new Database(resolved);
    // EVIDENCE, plus a bounded busy_timeout: this handle shares the file with
    // the graph's EVIDENCE writer and storage's RESUMABLE one, so a blocked
    // writer must wait a bounded window instead of failing the run instantly.
    // The window is the shared single-row-write default, not a new number.
    applySqliteDurability(db, 'EVIDENCE', { busyTimeoutMs });
  };

  try {
    open();
  } catch (error) {
    // A path that is not a SQLite database (restore fixtures, a wrong dbPath)
    // is not this module's error to raise: the caller falls back to the store
    // it already had, which is the pre-#2915 behaviour rather than a crash.
    if (db) { try { db.close(); } catch (_) { /* nothing to salvage */ } }
    db = null;
    return null;
  }

  return {
    dbPath: resolved,
    get db() { return db; },
    // Its own transaction, not the injected store's: the journal's commit is
    // what has to be durable, and it must not ride on a connection whose class
    // this module does not control.
    withTransaction(fn) {
      return db.transaction(fn)();
    },
    close() {
      if (!db) return;
      try { db.close(); } catch (_) { /* best effort, mirrors storage.close */ }
      db = null;
    },
    /**
     * Reopen after restore replaced the backing file (Windows EPERM, #1848).
     * Best effort for the same reason as the initial open: restore must finish
     * even when the replaced file turns out not to be a database, and a null
     * handle leaves the journal reading through the fallback store.
     */
    reopen() {
      if (db) return;
      try { open(); } catch (_) { db = null; }
    },
  };
}

module.exports = { openJournalConnection, isSharedableDbPath };
