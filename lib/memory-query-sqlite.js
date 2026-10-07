'use strict';

const { cloneMemoryRecord } = require('./memory-record-utils');
const { CONTENT_KIND_SQL } = require('./memory-store-sqlite-writer');

// Only the indexable query subset enters this path. Other filters continue
// through the query engine, which owns their validation and recall semantics.
function readSqlitePage({ db, memories, corruptRows }, filters) {
  if (!db || corruptRows.length) return null;
  const { opts, workspaceId, offset, limit, orderBy, order } = filters;
  // The existing JS slice accepts fractional and infinite offsets/limits;
  // SQLite LIMIT/OFFSET does not. Keep those legacy cases on the JS path.
  if (!Number.isSafeInteger(offset) ||
      (limit !== Infinity && !Number.isSafeInteger(limit)) ||
      (opts.status !== undefined && typeof opts.status !== 'string')) return null;
  // The store's comparator uses localeCompare, while SQLite's index uses
  // binary order. Generated ids are lowercase hex and order identically;
  // imported ids may not. A partial index makes the safety probe bounded.
  const unsafeIds = db.prepare(`SELECT 1 FROM memories INDEXED BY idx_memories_workspace_locale_unsafe
    WHERE workspace_id = ? AND memory_id GLOB '*[^0-9a-f]*' LIMIT 1`).get(workspaceId);
  if (unsafeIds) return null;
  if (opts.recall || opts.actor !== undefined || opts.sourceType !== undefined ||
      opts.sourceRef !== undefined || opts.contentIncludes || opts.text ||
      opts.metadata || opts.createdAfter || opts.createdBefore ||
      opts.updatedAfter || opts.updatedBefore) return null;
  // Ranked modes order by score, not by the SQL column; only the substring
  // path (and an explicit orderBy) may use the index.
  if (opts.retrievalMode !== undefined || opts.recency !== undefined) return null;
  // Imported records may carry a kind other than the writer's default, and the
  // SQL path has no kind predicate. Fall back for every explicit kind so
  // counting and pagination match the engine's kind normalization.
  if (opts.kind !== undefined) return null;

  const where = ['workspace_id = ?'];
  const args = [workspaceId];
  if (opts.contentKind !== undefined) {
    // #3208: the error-prevention preflight lists one content kind per gated
    // action; this keeps it on the index instead of a scan of every record.
    where.push(`(${CONTENT_KIND_SQL}) = ?`);
    args.push(opts.contentKind);
  }
  if (opts.status !== undefined) {
    where.push('status = ?');
    args.push(opts.status);
  } else if (opts.includeDeleted !== true && opts.includeTombstoned !== true) {
    // #3493: archived joins deleted as a hidden status. includeArchived alone
    // hides deleted but reveals archived; includeDeleted/includeTombstoned
    // reveal both, matching the JS engine's recordPassesFilter.
    if (opts.includeArchived === true) where.push("status IN ('active', 'archived')");
    else where.push("status = 'active'");
  }
  const predicate = where.join(' AND ');
  const column = { createdAt: 'created_at', updatedAt: 'updated_at', memoryId: 'memory_id' }[orderBy];
  const direction = order === 'desc' ? 'DESC' : 'ASC';
  const total = db.prepare(`SELECT count(*) AS count FROM memories WHERE ${predicate}`).get(...args).count;
  // The whitelist above is the only source of SQL identifiers and direction.
  // A null limit is the documented unbounded query, so only bounded calls
  // promise indexed page work.
  const pageSql = `SELECT memory_id FROM memories WHERE ${predicate} ORDER BY ${column} ${direction}, memory_id ASC LIMIT ? OFFSET ?`;
  const ids = db.prepare(pageSql).all(...args, limit === Infinity ? -1 : limit, offset);
  // #3208: a store with a db handle always holds the SQLite-backed collection.
  const page = ids.map(({ memory_id }) => memories.lookup(workspaceId, memory_id));
  // Warmup can quarantine a malformed row. Never expose it or return a wrong
  // total if the SQLite view and validated in-memory records diverge.
  if (page.some((record) => !record)) return null;
  return { ok: true, memories: page.map(cloneMemoryRecord), total,
    limit: limit === Infinity ? null : limit, offset };
}

module.exports = { readSqlitePage };
