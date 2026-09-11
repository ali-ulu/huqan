'use strict';

/**
 * When did this store start recording that a capability ran?
 *
 * scripts/capability-usage.js answers three things, never two: USED, NEVER, and
 * UNKNOWN -- "nothing here would record it either way". The distinction is the
 * whole value of that report, and wiring the gate telemetry sink threatens it:
 * the moment rows start arriving, a capability with no rows looks like a
 * capability that was never used, when the truth is that nobody was counting
 * until this morning.
 *
 * So the store stamps the instant instrumentation first attached to it. Before
 * that instant the report has nothing to say and must keep saying UNKNOWN;
 * after it, silence really is evidence of disuse. The stamp is written once and
 * never moved -- restamping on every open would make the window permanently one
 * process old, which reports UNKNOWN forever and is the same blindness wearing
 * an honest label.
 *
 * It gets a table of its own rather than a row in `observability_schema_meta`:
 * that table is `(schema_name, version INTEGER)` and belongs to the migration
 * runner. Widening a migration-owned table to hold a timestamp would couple the
 * two, and the migration version says when the schema arrived -- which is not
 * the same date, as this store proves: its schema was migrated long before
 * anything was ever written through it.
 */

const INSTRUMENTED_SINCE_KEY = 'capability_usage_instrumented_since';
const META_TABLE = 'capability_usage_meta';
const CREATE_META_TABLE = `CREATE TABLE IF NOT EXISTS ${META_TABLE} (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`;

/**
 * Stamp the store if it has never been stamped, and return the stamp either
 * way. `INSERT OR IGNORE` is what keeps the first value: the second process to
 * open the store writes nothing.
 */
function stampInstrumentedSince(db, now = () => new Date().toISOString()) {
  if (!db || typeof db.prepare !== 'function') return null;
  try {
    db.exec(CREATE_META_TABLE);
    db.prepare(`INSERT OR IGNORE INTO ${META_TABLE} (key, value) VALUES (?, ?)`)
      .run(INSTRUMENTED_SINCE_KEY, now());
    return readInstrumentedSinceFromDb(db);
  } catch (_) {
    // A store whose observability schema is missing or read-only is not a
    // reason to fail the operation the caller was actually performing. The
    // report reads the absent stamp as "not instrumented" and says UNKNOWN,
    // which is true.
    return null;
  }
}

function readInstrumentedSinceFromDb(db) {
  if (!db || typeof db.prepare !== 'function') return null;
  try {
    const row = db.prepare(`SELECT value FROM ${META_TABLE} WHERE key = ?`).get(INSTRUMENTED_SINCE_KEY);
    return row?.value || null;
  } catch (_) {
    return null;
  }
}

/**
 * Read the stamp straight from a database file, for readers -- the usage report,
 * tests -- that have a path rather than a live kernel.
 */
function readInstrumentedSince(dbPath) {
  let Database = null;
  try { Database = require('better-sqlite3'); } catch (_) { return null; }
  let db = null;
  try {
    db = new Database(dbPath, { readonly: true });
    return readInstrumentedSinceFromDb(db);
  } catch (_) {
    return null;
  } finally {
    try { db?.close(); } catch (_) {}
  }
}

module.exports = {
  INSTRUMENTED_SINCE_KEY,
  META_TABLE,
  readInstrumentedSince,
  readInstrumentedSinceFromDb,
  stampInstrumentedSince,
};
