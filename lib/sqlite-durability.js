'use strict';

/**
 * Which stores promise their contents survive a power cut, and which do not.
 *
 * The setting itself is one word, and that was the problem: it sat inline in
 * four files with the reason recorded in only one of them, so a value somebody
 * chose and a value nobody revisited looked identical in source. Read in one
 * place, the policy is simple and the split is deliberate.
 *
 * EVIDENCE -- fsync on commit. The store holds the audit record, and losing its
 * tail loses the record itself with nothing anywhere showing a gap. For a
 * product whose claim is evidence, that is the wrong trade at any price.
 *
 *   graph.js                            mutation_receipts, hash-chained
 *   lib/memory-store.js                 memory_events: actor, provenance,
 *                                       trust policy version, one row per
 *                                       mutation -- and not derived, since
 *                                       memory-store-sqlite-warmup replays
 *                                       every row into the event log at startup
 *   lib/external-client-replay-store.js replay reservations, which are what
 *                                       makes at-most-once hold over a restart
 *
 * RESUMABLE -- no fsync on commit. Losing the last write costs work, not
 * evidence, so the throughput is worth having.
 *
 *   storage.js                          agent checkpoints: a run resumes from
 *                                       an earlier checkpoint and repeats some
 *                                       steps
 *
 * THE COST, measured before choosing rather than argued after. 2000 separate
 * commits, three runs, Windows/Node 22:
 *
 *   NORMAL   35 us per commit
 *   FULL    450 us per commit      12.7x
 *
 * The ratio sounds alarming and is not, because the fsync is per commit and
 * every write on these paths goes through a transaction. It is +0.4 ms per
 * mutation, on a path that already runs policy evaluation, receipt construction
 * and hashing. Re-measure before moving a store between the two classes; do not
 * move one on the ratio alone.
 *
 * WAL is common to both: readers never block the writer. `synchronous` is the
 * only axis this file decides.
 *
 * graph.js applies its own preamble through lib/graph-sqlite-pragmas.js, which
 * has to build one SQL string for its schema DDL; the policy above is the same
 * and the two must not drift. test/sqlite-durability-contract.test.js holds
 * them together.
 */

const DURABILITY = Object.freeze({
  /** The audit record. Survives a power cut. */
  EVIDENCE: 'FULL',
  /** Resumable state. A lost tail costs work, not evidence. */
  RESUMABLE: 'NORMAL',
});

/**
 * Apply the shared connection policy to a better-sqlite3 handle.
 *
 * @param {{pragma: function}} db
 * @param {'EVIDENCE'|'RESUMABLE'} durability which class this store is in
 * @param {{busyTimeoutMs?: number}} [options]
 */
function applySqliteDurability(db, durability, options = {}) {
  if (!Object.hasOwn(DURABILITY, durability)) {
    throw new TypeError(`unknown durability class: ${durability}`);
  }
  db.pragma('journal_mode = WAL');
  db.pragma(`synchronous = ${DURABILITY[durability]}`);
  if (Number.isFinite(options.busyTimeoutMs)) {
    db.pragma(`busy_timeout = ${Math.floor(options.busyTimeoutMs)}`);
  }
}

module.exports = { DURABILITY, applySqliteDurability };
