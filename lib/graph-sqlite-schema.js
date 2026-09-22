'use strict';

// Extracted from graph.js _initDB by #2126. Tables, legacy migrations and
// indexes (initGraphSchema) plus the prepared-statement set
// (createGraphStmts) move here verbatim; Graph keeps a five-line _initDB
// that runs them against its own handle. No store receiver, no behaviour
// decision: every SQL statement is byte-identical to the moved block.

const { sqlitePragmaSql } = require('./graph-sqlite-pragmas');
const { ensureMutationReceiptFamilySchema } = require('./graph-mutation-receipt-schema');

function initGraphSchema(db, opts = {}) {
    db.exec(`
      ${sqlitePragmaSql({ busyTimeoutMs: opts.busyTimeoutMs })}
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT NOT NULL,
        workspace_id TEXT NOT NULL DEFAULT 'default',
        label TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 0.5,
        created INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT '',
        last_accessed INTEGER NOT NULL,
        last_seen TEXT NOT NULL DEFAULT '',
        vector TEXT NOT NULL DEFAULT '{}',
        provenance TEXT NOT NULL DEFAULT 'null',
        PRIMARY KEY (workspace_id, id)
      );
        CREATE TABLE IF NOT EXISTS edges (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id TEXT NOT NULL DEFAULT 'default',
          from_id TEXT NOT NULL,
          to_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 0.5,
        confidence REAL NOT NULL DEFAULT 0.5,
        source TEXT NOT NULL DEFAULT 'manual',
        source_ref TEXT NOT NULL DEFAULT '',
        session_id TEXT NOT NULL DEFAULT '',
        evidence TEXT NOT NULL DEFAULT '[]',
        evidence_type TEXT NOT NULL DEFAULT '',
        confidence_history TEXT NOT NULL DEFAULT '[]',
        company_mode INTEGER NOT NULL DEFAULT 0,
          source_type TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT '',
          provenance TEXT NOT NULL DEFAULT 'null',
          meta TEXT NOT NULL DEFAULT '{}',
          created INTEGER NOT NULL,
          UNIQUE(workspace_id, from_id, to_id, relation)
        );
      CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
      CREATE INDEX IF NOT EXISTS idx_edges_to   ON edges(to_id);
      CREATE TABLE IF NOT EXISTS audit_log (
        audit_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        workspace_id TEXT NOT NULL DEFAULT 'default',
        actor TEXT,
        timestamp TEXT NOT NULL,
        source_ref TEXT,
        provenance_id TEXT,
        trust_policy_version TEXT,
        details TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS candidate_claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        candidate_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL DEFAULT 'default',
        claim TEXT NOT NULL DEFAULT '',
        proposed_edge TEXT NOT NULL DEFAULT 'null',
        provenance TEXT NOT NULL DEFAULT 'null',
        conflict TEXT NOT NULL DEFAULT 'null',
        recommendation TEXT NOT NULL DEFAULT 'accept',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT '',
        reviewed_at TEXT NOT NULL DEFAULT '',
        reviewed_by TEXT NOT NULL DEFAULT '',
        warnings TEXT NOT NULL DEFAULT '[]',
        UNIQUE(workspace_id, candidate_id)
      );
      CREATE TABLE IF NOT EXISTS mutation_journal (
        operation_id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK(status IN ('completed')),
        result TEXT NOT NULL,
        completed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mutation_receipts (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_id TEXT NOT NULL UNIQUE,
        receipt_id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL,
        receipt_family TEXT NOT NULL CHECK(receipt_family IN ('v4', 'non-v4')),
        canonical_payload TEXT NOT NULL,
        previous_receipt_hash TEXT NOT NULL,
        receipt_hash TEXT NOT NULL UNIQUE,
        committed_at TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS audit_log_no_update
      BEFORE UPDATE ON audit_log
      BEGIN
        SELECT RAISE(ABORT, 'audit_log is append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
      BEFORE DELETE ON audit_log
      BEGIN
        SELECT RAISE(ABORT, 'audit_log is append-only');
      END;
    `);

    const edgeColumns = db.prepare('PRAGMA table_info(edges)').all().map(c => c.name);
    const nodeColumns = db.prepare('PRAGMA table_info(nodes)').all().map(c => c.name);
    const candidateColumns = db.prepare('PRAGMA table_info(candidate_claims)').all().map(c => c.name);
    const nodeSchemaRow = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'nodes'").get();
    const nodeSchema = String(nodeSchemaRow?.sql || '');
    const nodeHasLegacyPrimaryKey = /id\s+TEXT\s+PRIMARY\s+KEY/i.test(nodeSchema) && !/PRIMARY\s+KEY\s*\(\s*workspace_id\s*,\s*id\s*\)/i.test(nodeSchema);
    let nodeSchemaMigrated = false;
    if (nodeHasLegacyPrimaryKey) {
      db.exec(`
        ALTER TABLE nodes RENAME TO nodes_legacy;
        CREATE TABLE nodes (
          id TEXT NOT NULL,
          workspace_id TEXT NOT NULL DEFAULT 'default',
          label TEXT NOT NULL,
          weight REAL NOT NULL DEFAULT 0.5,
          created INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT '',
          last_accessed INTEGER NOT NULL,
          last_seen TEXT NOT NULL DEFAULT '',
          vector TEXT NOT NULL DEFAULT '{}',
          provenance TEXT NOT NULL DEFAULT 'null',
          PRIMARY KEY (workspace_id, id)
        );
        INSERT INTO nodes (id, workspace_id, label, weight, created, created_at, last_accessed, last_seen, vector, provenance)
        SELECT
          id,
          'default',
          label,
          weight,
          created,
          created_at,
          last_accessed,
          last_seen,
          vector,
          'null'
        FROM nodes_legacy;
        DROP TABLE nodes_legacy;
      `);
      nodeSchemaMigrated = true;
    }
    if (!nodeSchemaMigrated && !nodeColumns.includes('workspace_id')) db.exec("ALTER TABLE nodes ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default'");
    if (!nodeSchemaMigrated && !nodeColumns.includes('created_at')) db.exec("ALTER TABLE nodes ADD COLUMN created_at TEXT NOT NULL DEFAULT ''");
    if (!nodeSchemaMigrated && !nodeColumns.includes('last_seen')) db.exec("ALTER TABLE nodes ADD COLUMN last_seen TEXT NOT NULL DEFAULT ''");
    if (!nodeSchemaMigrated && !nodeColumns.includes('provenance')) db.exec("ALTER TABLE nodes ADD COLUMN provenance TEXT NOT NULL DEFAULT 'null'");
    if (!edgeColumns.includes('workspace_id')) db.exec("ALTER TABLE edges ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default'");
    if (!edgeColumns.includes('confidence')) db.exec('ALTER TABLE edges ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5');
    if (!edgeColumns.includes('source')) db.exec("ALTER TABLE edges ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
    if (!edgeColumns.includes('source_ref')) db.exec("ALTER TABLE edges ADD COLUMN source_ref TEXT NOT NULL DEFAULT ''");
    if (!edgeColumns.includes('session_id')) db.exec("ALTER TABLE edges ADD COLUMN session_id TEXT NOT NULL DEFAULT ''");
    if (!edgeColumns.includes('evidence')) db.exec("ALTER TABLE edges ADD COLUMN evidence TEXT NOT NULL DEFAULT '[]'");
    if (!edgeColumns.includes('evidence_type')) db.exec("ALTER TABLE edges ADD COLUMN evidence_type TEXT NOT NULL DEFAULT ''");
    if (!edgeColumns.includes('confidence_history')) db.exec("ALTER TABLE edges ADD COLUMN confidence_history TEXT NOT NULL DEFAULT '[]'");
    if (!edgeColumns.includes('company_mode')) db.exec("ALTER TABLE edges ADD COLUMN company_mode INTEGER NOT NULL DEFAULT 0");
    if (!edgeColumns.includes('source_type')) db.exec("ALTER TABLE edges ADD COLUMN source_type TEXT NOT NULL DEFAULT ''");
    if (!edgeColumns.includes('updated_at')) db.exec("ALTER TABLE edges ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''");
    if (!edgeColumns.includes('created_at')) db.exec("ALTER TABLE edges ADD COLUMN created_at TEXT NOT NULL DEFAULT ''");
    if (!edgeColumns.includes('strength')) db.exec('ALTER TABLE edges ADD COLUMN strength REAL NOT NULL DEFAULT 0.5');
    if (!edgeColumns.includes('provenance')) db.exec("ALTER TABLE edges ADD COLUMN provenance TEXT NOT NULL DEFAULT 'null'");
    if (!edgeColumns.includes('meta')) db.exec("ALTER TABLE edges ADD COLUMN meta TEXT NOT NULL DEFAULT '{}'");
    if (!candidateColumns.includes('candidate_id')) db.exec("ALTER TABLE candidate_claims ADD COLUMN candidate_id TEXT NOT NULL DEFAULT ''");
    if (!candidateColumns.includes('workspace_id')) db.exec("ALTER TABLE candidate_claims ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default'");
    if (!candidateColumns.includes('claim')) db.exec("ALTER TABLE candidate_claims ADD COLUMN claim TEXT NOT NULL DEFAULT ''");
    if (!candidateColumns.includes('proposed_edge')) db.exec("ALTER TABLE candidate_claims ADD COLUMN proposed_edge TEXT NOT NULL DEFAULT 'null'");
    if (!candidateColumns.includes('provenance')) db.exec("ALTER TABLE candidate_claims ADD COLUMN provenance TEXT NOT NULL DEFAULT 'null'");
    if (!candidateColumns.includes('conflict')) db.exec("ALTER TABLE candidate_claims ADD COLUMN conflict TEXT NOT NULL DEFAULT 'null'");
    if (!candidateColumns.includes('recommendation')) db.exec("ALTER TABLE candidate_claims ADD COLUMN recommendation TEXT NOT NULL DEFAULT 'accept'");
    if (!candidateColumns.includes('status')) db.exec("ALTER TABLE candidate_claims ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'");
    if (!candidateColumns.includes('created_at')) db.exec("ALTER TABLE candidate_claims ADD COLUMN created_at TEXT NOT NULL DEFAULT ''");
    if (!candidateColumns.includes('reviewed_at')) db.exec("ALTER TABLE candidate_claims ADD COLUMN reviewed_at TEXT NOT NULL DEFAULT ''");
    if (!candidateColumns.includes('reviewed_by')) db.exec("ALTER TABLE candidate_claims ADD COLUMN reviewed_by TEXT NOT NULL DEFAULT ''");
    if (!candidateColumns.includes('warnings')) db.exec("ALTER TABLE candidate_claims ADD COLUMN warnings TEXT NOT NULL DEFAULT '[]'");

    ensureMutationReceiptFamilySchema(db);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_nodes_workspace_label ON nodes(workspace_id, label);
      CREATE INDEX IF NOT EXISTS idx_edges_workspace_from ON edges(workspace_id, from_id);
      CREATE INDEX IF NOT EXISTS idx_edges_workspace_to ON edges(workspace_id, to_id);
      CREATE INDEX IF NOT EXISTS idx_edges_workspace_relation ON edges(workspace_id, relation);
      CREATE INDEX IF NOT EXISTS idx_edges_workspace_from_to_relation ON edges(workspace_id, from_id, to_id, relation);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_workspace_unique ON edges(workspace_id, from_id, to_id, relation);
      CREATE INDEX IF NOT EXISTS idx_audit_workspace_timestamp ON audit_log(workspace_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_candidates_workspace_status ON candidate_claims(workspace_id, status, recommendation);
      CREATE INDEX IF NOT EXISTS idx_candidates_workspace_created ON candidate_claims(workspace_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_mutation_journal_completed ON mutation_journal(completed_at);
      CREATE INDEX IF NOT EXISTS idx_mutation_receipts_workspace_sequence ON mutation_receipts(workspace_id, sequence DESC);
    `);
}

function createGraphStmts(db) {
    // Prepared statements
  return {
      upsertNode: db.prepare(`
        INSERT INTO nodes (id, workspace_id, label, weight, created, created_at, last_accessed, last_seen, vector, provenance)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, id) DO UPDATE SET
          workspace_id = excluded.workspace_id,
          label = excluded.label,
          weight = excluded.weight,
          last_accessed = excluded.last_accessed,
          last_seen = excluded.last_seen,
          provenance = excluded.provenance
      `),
      getNode: db.prepare('SELECT * FROM nodes WHERE id = ? AND workspace_id = ?'),
      deleteNode: db.prepare('DELETE FROM nodes WHERE id = ? AND workspace_id = ?'),
      deleteEdgesOf: db.prepare('DELETE FROM edges WHERE (from_id = ? OR to_id = ?) AND workspace_id = ?'),
      touchNode: db.prepare('UPDATE nodes SET last_accessed = ? WHERE id = ? AND workspace_id = ?'),
      upsertEdge: db.prepare(`
        INSERT INTO edges (workspace_id, from_id, to_id, relation, weight, confidence, source, source_ref, session_id, evidence, evidence_type, confidence_history, company_mode, source_type, updated_at, created_at, provenance, meta, created, strength)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, from_id, to_id, relation) DO UPDATE SET
          workspace_id = excluded.workspace_id,
          weight = excluded.weight,
          confidence = excluded.confidence,
          source = excluded.source,
          source_ref = excluded.source_ref,
          session_id = excluded.session_id,
          evidence = excluded.evidence,
          evidence_type = excluded.evidence_type,
          confidence_history = excluded.confidence_history,
          company_mode = excluded.company_mode,
          source_type = excluded.source_type,
          updated_at = excluded.updated_at,
          provenance = excluded.provenance,
          meta = excluded.meta,
          strength = excluded.strength
      `),
      getEdge: db.prepare('SELECT * FROM edges WHERE from_id = ? AND to_id = ? AND relation = ? AND workspace_id = ?'),
      getEdges: db.prepare('SELECT * FROM edges WHERE from_id = ? AND workspace_id = ?'),
      getInEdges: db.prepare('SELECT * FROM edges WHERE to_id = ? AND workspace_id = ?'),
      getCandidateClaim: db.prepare('SELECT * FROM candidate_claims WHERE candidate_id = ? AND workspace_id = ?'),
      allCandidateClaims: db.prepare('SELECT * FROM candidate_claims ORDER BY created_at ASC, candidate_id ASC'),
      upsertCandidateClaim: db.prepare(`
        INSERT INTO candidate_claims (
          candidate_id, workspace_id, claim, proposed_edge, provenance, conflict,
          recommendation, status, created_at, reviewed_at, reviewed_by, warnings
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, candidate_id) DO UPDATE SET
          claim = excluded.claim,
          proposed_edge = excluded.proposed_edge,
          provenance = excluded.provenance,
          conflict = excluded.conflict,
          recommendation = excluded.recommendation,
          status = excluded.status,
          created_at = excluded.created_at,
          reviewed_at = excluded.reviewed_at,
          reviewed_by = excluded.reviewed_by,
          warnings = excluded.warnings
      `),
      pruneEdges: db.prepare('DELETE FROM edges WHERE weight < ? AND workspace_id = ?'),
      deleteEdge: db.prepare('DELETE FROM edges WHERE workspace_id = ? AND from_id = ? AND to_id = ? AND relation = ?'),
      countNodes: db.prepare('SELECT COUNT(*) as c FROM nodes'),
      countEdges: db.prepare('SELECT COUNT(*) as c FROM edges'),
      allNodes: db.prepare('SELECT * FROM nodes'),
      allEdges: db.prepare('SELECT * FROM edges'),
      updateEdgeWeight: db.prepare('UPDATE edges SET weight = ?, confidence = ?, source = ?, source_ref = ?, session_id = ?, evidence = ?, evidence_type = ?, confidence_history = ?, company_mode = ?, source_type = ?, updated_at = ?, provenance = ?, meta = ?, strength = ?, workspace_id = ? WHERE workspace_id = ? AND from_id = ? AND to_id = ? AND relation = ?'),
      updateNodeVector: db.prepare('UPDATE nodes SET vector = ? WHERE id = ? AND workspace_id = ?'),
      insertAuditEvent: db.prepare(`
        INSERT OR IGNORE INTO audit_log (
          audit_id, event_type, target_type, target_id, workspace_id, actor, timestamp,
          source_ref, provenance_id, trust_policy_version, details
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      allAuditEvents: db.prepare('SELECT * FROM audit_log ORDER BY timestamp ASC, audit_id ASC'),
      countAuditEvents: db.prepare('SELECT COUNT(*) AS total FROM audit_log'),
      getMutationJournal: db.prepare('SELECT operation_id, status, result, completed_at FROM mutation_journal WHERE operation_id = ?'),
      insertMutationJournal: db.prepare('INSERT INTO mutation_journal (operation_id, status, result, completed_at) VALUES (?, ?, ?, ?)'),
      getMutationReceiptByOperation: db.prepare('SELECT * FROM mutation_receipts WHERE operation_id = ?'),
      getMutationReceiptById: db.prepare('SELECT * FROM mutation_receipts WHERE receipt_id = ?'),
      getLatestMutationReceiptHash: db.prepare('SELECT receipt_hash FROM mutation_receipts WHERE workspace_id = ? AND receipt_family = ? ORDER BY sequence DESC LIMIT 1'),
      insertMutationReceipt: db.prepare('INSERT INTO mutation_receipts (operation_id, receipt_id, workspace_id, receipt_family, canonical_payload, previous_receipt_hash, receipt_hash, committed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    };
}

module.exports = { initGraphSchema, createGraphStmts };
