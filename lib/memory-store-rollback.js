'use strict';

/**
 * Rollback for MemoryStore's in-memory mirror.
 *
 * The store keeps `_memories`/`_events`/`_links` alongside its SQLite rows and
 * writes both inside the same transaction. A SQLite transaction rolls back the
 * rows and nothing else, so the mirror is this module's job: without it, a
 * failed transaction left the live store answering reads from records the
 * database no longer held, and the two only agreed again after a restart
 * (#761). Snapshots are therefore taken on every backend, not just the
 * in-memory one.
 *
 * The clone is deep where a caller could mutate through it -- content,
 * metadata, provenance, details -- and shallow elsewhere, because the
 * remaining fields are scalars.
 */

function cloneJson(value) {
  return value ? JSON.parse(JSON.stringify(value)) : null;
}

function snapshotInMemoryState(store) {
  return {
    // #3208: the SQLite backend holds only a cache; SQLite's own rollback
    // restores the rows, so restore just drops what the cache may hold.
    memories: typeof store._memories.clearCache === 'function' ? store._memories : new Map(
      Array.from(store._memories.entries()).map(([key, record]) => [
        key,
        {
          ...record,
          content: typeof record.content === 'object' && record.content !== null
            ? JSON.parse(JSON.stringify(record.content))
            : record.content,
          metadata: cloneJson(record.metadata),
        },
      ])
    ),
    // #3208 slice 2: the SQLite event log holds nothing to restore.
    events: typeof store._events.forWorkspace === 'function' ? store._events : store._events.map((event) => ({
      ...event,
      details: cloneJson(event.details),
      provenance: cloneJson(event.provenance),
    })),
    links: store._links.map((link) => ({
      ...link,
      provenance: cloneJson(link.provenance),
    })),
  };
}

function restoreInMemoryState(store, snapshot) {
  if (!snapshot) return;
  if (typeof snapshot.memories.clearCache === 'function') snapshot.memories.clearCache();
  store._memories = snapshot.memories;
  store._events = snapshot.events;
  store._links = snapshot.links;
}

module.exports = { snapshotInMemoryState, restoreInMemoryState };
