/**
 * Connection pragmas for the SQLite graph backend.
 *
 * Extracted from graph.js so the pragma set has a home of its own: graph.js is
 * over the file-size ratchet's 800-line budget (issue #328) and may not grow,
 * and pragmas are exactly the kind of connection policy worth reading in one
 * place rather than buried in the schema DDL.
 *
 *   journal_mode = WAL   readers never block the writer.
 *   synchronous  = FULL  full durability (#1432) -- the graph is canonical.
 *   busy_timeout         a blocked writer waits instead of failing instantly
 *                        with SQLITE_BUSY. better-sqlite3 is synchronous, so
 *                        this window is time the process spends blocked.
 *
 * The 5 s default is set by how long the graph actually holds the write lock.
 * A single node/edge write is ~1 ms (p99 4.5 ms), but save() rewrites the
 * whole graph in one transaction, so its hold time scales with graph size:
 * 32 ms at 500 nodes, 231 ms at 2k, 1.45 s at 10k. That is why this cannot
 * follow lib/memory-store.js's 250 ms -- the memory store has no full-state
 * rewrite, and 250 ms here would fail concurrent writers on any graph past
 * ~2k nodes, which is the bulk-ingest case the timeout exists for.
 *
 * It stays tunable because the wait is not free: a blocked writer stalls the
 * whole event loop for the window, so an operator running a small graph, or
 * one who would rather fail fast than stall, can lower it.
 */

const DEFAULT_BUSY_TIMEOUT_MS = 5000;

function resolveBusyTimeoutMs(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return DEFAULT_BUSY_TIMEOUT_MS;
  return Math.floor(num);
}

/** SQL preamble applied to every SQLite graph connection. */
function sqlitePragmaSql(opts = {}) {
  const busyTimeoutMs = resolveBusyTimeoutMs(opts.busyTimeoutMs);
  return [
    'PRAGMA journal_mode = WAL;',
    'PRAGMA synchronous = FULL;',
    `PRAGMA busy_timeout = ${busyTimeoutMs};`,
  ].join('\n      ');
}

module.exports = {
  DEFAULT_BUSY_TIMEOUT_MS,
  resolveBusyTimeoutMs,
  sqlitePragmaSql,
};
