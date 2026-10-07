'use strict';

// SQLite schema and prepared statements for MemoryStore, split out of
// lib/memory-store-sqlite-writer.js by #3492 to keep that file under its
// size threshold (#328). The writer owns the handle and delegates here; this
// module touches only the db handle it is handed and requires no store.

const { ensureMemoryEventRelatedMemoryColumn } = require('./memory-schema');
const { ensureMemoryEventColumns, ensureMemoryLinkColumns, ensureMemoryRecordColumns } = require('./memory-schema-normalize');

// #3208: `content.kind` as SQL, for the contentKind list (error-prevention
// preflight). json_valid guards the extraction so one malformed row cannot
// fail the index build at open, and only a JSON string counts, matching the
// strict `record.content.kind === kind` comparison in memory-record-read.js.
// CASE branches evaluate lazily, which AND does not guarantee.
const CONTENT_KIND_SQL = "CASE WHEN json_valid(content_json) THEN CASE json_type(content_json, '$.kind') " +
  "WHEN 'text' THEN json_extract(content_json, '$.kind') END END";

function initMemorySchema(db) {
  db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        workspace_id TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        content_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        trust_policy_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT,
        deleted_at TEXT,
        supersedes_memory_id TEXT,
        supersedes_hash TEXT,
        PRIMARY KEY (workspace_id, memory_id)
      );

      CREATE TABLE IF NOT EXISTS memory_events (
        workspace_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        details_json TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        trust_policy_version TEXT NOT NULL,
        created_at TEXT NOT NULL, related_memory_id TEXT,
        PRIMARY KEY (workspace_id, event_id)
      );

      CREATE TABLE IF NOT EXISTS memory_links (
        workspace_id TEXT NOT NULL,
        link_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        from_memory_id TEXT NOT NULL,
        to_memory_id TEXT NOT NULL,
        confidence REAL,
        provenance_json TEXT NOT NULL,
        trust_policy_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        metadata_json TEXT,
        schema_version TEXT,
        supersedes_hash TEXT,
        new_content_hash TEXT,
        PRIMARY KEY (workspace_id, link_id)
      );

      CREATE INDEX IF NOT EXISTS idx_memories_workspace_created ON memories(workspace_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_memories_workspace_status ON memories(workspace_id, status);
      CREATE INDEX IF NOT EXISTS idx_memories_workspace_status_created ON memories(workspace_id, status, created_at, memory_id);
      CREATE INDEX IF NOT EXISTS idx_memories_workspace_updated ON memories(workspace_id, updated_at, memory_id);
      CREATE INDEX IF NOT EXISTS idx_memories_workspace_locale_unsafe ON memories(workspace_id)
        WHERE memory_id GLOB '*[^0-9a-f]*';
      CREATE INDEX IF NOT EXISTS idx_memories_workspace_content_kind
        ON memories(workspace_id, (${CONTENT_KIND_SQL}), status, created_at, memory_id);
      CREATE INDEX IF NOT EXISTS idx_memory_events_workspace_id_created ON memory_events(workspace_id, memory_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_memory_links_from ON memory_links(workspace_id, from_memory_id);
      CREATE INDEX IF NOT EXISTS idx_memory_links_to ON memory_links(workspace_id, to_memory_id);
    `);
  ensureMemoryEventRelatedMemoryColumn(db);
  ensureMemoryEventColumns(db);
  ensureMemoryLinkColumns(db);
  ensureMemoryRecordColumns(db);
  // #3208 slice 2: history() reads events by the memory they relate to.
  db.exec('CREATE INDEX IF NOT EXISTS idx_memory_events_workspace_related ON memory_events(workspace_id, related_memory_id)');
}

function createMemoryStmts(db) {
  return {
    upsertMemory: db.prepare(`
        INSERT INTO memories (
          workspace_id, memory_id, kind, content_json, content_hash, status,
          metadata_json, provenance_json, trust_policy_version, created_at,
          updated_at, deleted_at, supersedes_memory_id, supersedes_hash
        ) VALUES (
          @workspace_id, @memory_id, @kind, @content_json, @content_hash, @status,
          @metadata_json, @provenance_json, @trust_policy_version, @created_at,
          @updated_at, @deleted_at, @supersedes_memory_id, @supersedes_hash
        )
        ON CONFLICT(workspace_id, memory_id) DO UPDATE SET
          status = excluded.status,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at,
          supersedes_hash = excluded.supersedes_hash
      `),
    insertEvent: db.prepare(`
        INSERT INTO memory_events (
          workspace_id, event_id, event_type, memory_id, actor, details_json,
          provenance_json, trust_policy_version, created_at, related_memory_id,
          reviewed_at, reviewed_by, schema_version
        ) VALUES (
          @workspace_id, @event_id, @event_type, @memory_id, @actor, @details_json,
          @provenance_json, @trust_policy_version, @created_at, @related_memory_id,
          @reviewed_at, @reviewed_by, @schema_version
        )
      `),
    insertLink: db.prepare(`
        INSERT INTO memory_links (
          workspace_id, link_id, relation, from_memory_id, to_memory_id, confidence,
          provenance_json, trust_policy_version, created_at, metadata_json, schema_version,
          supersedes_hash, new_content_hash
        ) VALUES (
          @workspace_id, @link_id, @relation, @from_memory_id, @to_memory_id, @confidence,
          @provenance_json, @trust_policy_version, @created_at, @metadata_json, @schema_version,
          @supersedes_hash, @new_content_hash
        )
      `),
    // #3208: memories are read on demand; the full-table read is paged.
    memoriesAfterRowid: db.prepare(`SELECT rowid AS row_id, * FROM memories WHERE rowid > ? ORDER BY rowid LIMIT ?`),
    memoryByKey: db.prepare(`SELECT * FROM memories WHERE workspace_id = ? AND memory_id = ?`),
    memoryCount: db.prepare(`SELECT count(*) AS count FROM memories`),
    // #3208 slice 2: events are read per scope; the full-table read is paged.
    eventsAfterRowid: db.prepare(`SELECT rowid AS row_id, * FROM memory_events WHERE rowid > ? ORDER BY rowid LIMIT ?`),
    eventsForWorkspace: db.prepare(`SELECT * FROM memory_events WHERE workspace_id = ? ORDER BY rowid`),
    eventsForMemory: db.prepare(`SELECT * FROM memory_events WHERE workspace_id = ? AND memory_id = ? ORDER BY rowid`),
    // A UNION, not `memory_id = ? OR related_memory_id = ?`: with OR, SQLite
    // uses only the workspace prefix and scans the workspace's events.
    eventsForHistory: db.prepare(`SELECT rowid AS row_id, * FROM memory_events WHERE workspace_id = ? AND memory_id = ?
      UNION SELECT rowid AS row_id, * FROM memory_events WHERE workspace_id = ? AND related_memory_id = ?
      ORDER BY row_id`),
    eventByKey: db.prepare(`SELECT * FROM memory_events WHERE workspace_id = ? AND event_id = ?`),
    // #3208 slice 3: links are read per scope; the full-table read is paged.
    linksAfterRowid: db.prepare(`SELECT rowid AS row_id, * FROM memory_links WHERE rowid > ? ORDER BY rowid LIMIT ?`),
    linksForWorkspace: db.prepare(`SELECT * FROM memory_links WHERE workspace_id = ? ORDER BY rowid`),
    // A UNION for the same reason as eventsForHistory: each side uses its index.
    linksForMemory: db.prepare(`SELECT rowid AS row_id, * FROM memory_links WHERE workspace_id = ? AND from_memory_id = ?
      UNION SELECT rowid AS row_id, * FROM memory_links WHERE workspace_id = ? AND to_memory_id = ?
      ORDER BY row_id`),
    linkByKey: db.prepare(`SELECT * FROM memory_links WHERE workspace_id = ? AND link_id = ?`),
  };
}

module.exports = {
  CONTENT_KIND_SQL,
  initMemorySchema,
  createMemoryStmts,
};
