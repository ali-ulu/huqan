const fs = require('fs');
const path = require('path');
const { buildAuditEvent, normalizeAuditEvent } = require('./lib/audit-log');
const { normalizeCandidateClaim } = require('./lib/conflict-detector');
const { appendReceiptToChain } = require('./lib/receipt/receipt-chain');
const {
  assertDurableV4WriteAllowed,
  classifyReceiptFamily,
} = require('./lib/receipt/v4-receipt-family');

// SQLite opsiyonel — yoksa JSON fallback
let Database;
try { Database = require('better-sqlite3'); } catch (_) { Database = null; }

const {
  CAUSAL_RELATIONS,
  STANDARD_RELATIONS,
  EDGE_META_NAMESPACE,
  EDGE_META_MAX_BYTES,
  RECEIPT_FAMILY_MIGRATION_ERROR_CODE,
  RECEIPT_FAMILIES,
  CAUSAL_RELATION_PRIORITY,
  atomicWriteFileSync,
  receiptFamilyMigrationError,
  normalizeWorkspaceId,
  nodeStorageKey,
  edgeIndexKey,
  nowIso,
  deepClone,
  isPlainObject,
  normalizeNodeRecord,
  cloneNodeMap,
  cloneNodeRecord,
  cloneEdgeRecord,
  clamp01,
  edgeSortKey,
  compareCausalEdges,
  sanitizeEdgeMeta,
  normalizeLoadedEdge,
  edgeUpdateArgs,
} = require('./lib/graph-record-utils');
const { derivePersistenceLayout } = require('./lib/memory-store-utils');
const { handleSqliteInitializationError, hasExistingPersistenceFile, sqlitePersistenceError } = require('./lib/sqlite-persistence-validation');
const { countAuditEvents, queryAuditEvents, readAuditEvents } = require('./lib/audit-query');
const { assertChainTipUsable, emptyMutationJournal, readMutationJournal, readCommittedMutationResult, readCommittedMutationResultsByPrefix, withMutationJournalLock } = require('./lib/mutation-journal');
const { applyTemporalEdgeMetadata, beginEdgeTouchScope, downgradeEdge, edgeTouchKey } = require('./lib/graph-edge-mutations');
const { getCausalChain: runCausalChain } = require('./lib/graph-causal-chain');
const { getCandidateClaims: runCandidateClaimsRead } = require('./lib/graph-candidate-claims-read');
const { addCandidateClaim: runCandidateClaimWrite } = require('./lib/graph-candidate-claims-write');
const {
  getEdge: runEdgeRead,
  getEdgesBetween: runEdgesBetweenRead,
  hasAnyEdge: runHasAnyEdgeRead,
  getEdges: runEdgesRead,
  getInEdges: runInEdgesRead,
  getAllEdges: runAllEdgesRead,
} = require('./lib/graph-edge-read');
const {
  readMutationReceiptFromJsonJournal,
  readMutationReceipt,
  getCommittedMutationReceiptByOperation: runReceiptByOperationRead,
  getCommittedMutationReceiptById: runReceiptByIdRead,
} = require('./lib/graph-mutation-receipt-read');
const { getNode: runNodeRead, getNodes: runNodesRead } = require('./lib/graph-node-read');
const { addNode: runNodeWrite } = require('./lib/graph-node-write');
const { removeNode: runNodeDelete } = require('./lib/graph-node-delete');
const { touchNode: runNodeTouch } = require('./lib/graph-node-touch');
const { addTag: runNodeTag } = require('./lib/graph-node-tag');
const { getWeight: runNodeWeight } = require('./lib/graph-node-weight');
const { cosineSimilarity: runNodeSimilarity } = require('./lib/graph-node-similarity');
const { getStats: runGraphStats } = require('./lib/graph-stats');
const { countNodes: runNodeCount, countEdges: runEdgeCount } = require('./lib/graph-count-read');
const { query: runGraphQuery } = require('./lib/graph-query-read');
const { createMutationRollbackSnapshot, restoreMutationRollbackSnapshot } = require('./lib/graph-mutation-rollback');
const { prune: runGraphPrune } = require('./lib/graph-prune');
const { optimize: runGraphOptimize } = require('./lib/graph-optimize');
const { isCausalRelation: runIsCausalRelation, getCausalRelations: runCausalRelations, getCausalEdges: runCausalEdges } = require('./lib/graph-causal-relation-read');
const { addEdge: runEdgeWrite } = require('./lib/graph-edge-write');
const { ensureMutationReceiptFamilySchema: runMutationReceiptFamilySchema } = require('./lib/graph-mutation-receipt-schema');
const consolidateEdges = require('./lib/graph-consolidate-edges');

class Graph {
  /**
   * @param {object|string} [opts]
   * @param {string}  [opts.memoryPath]      - JSON hafıza dosyası (varsayılan: memory.json)
   * @param {string}  [opts.dbPath]          - SQLite dosyası (varsayılan: memory.db, null = devre dışı)
   * @param {boolean} [opts.useSQLite]       - SQLite kullan (varsayılan: true, eğer better-sqlite3 varsa)
   * @param {number}  [opts.decayLambda]
   * @param {number}  [opts.pruneThreshold]
   */
  constructor(opts) {
    if (typeof opts === 'string') opts = { memoryPath: opts };
    opts = opts || {};
    this.memoryPath = opts.memoryPath || 'memory.json';
    this._paths = derivePersistenceLayout(this.memoryPath, opts.dbPath);
    this._embeddingPath = this._paths.embeddingPath;
    this._decayLambda = opts.decayLambda || 0.05;
    this._pruneThreshold = opts.pruneThreshold || 0.01;
    this._nodes = {};
    this._edges = [];
    this._candidateClaims = [];
    this._auditEvents = [];
    this._outIndex = new Map();
    this._inIndex = new Map();
    this._auditQueryStmts = new Map();
    this._edgeTouchScope = null;

    // SQLite kurulumu
    const wantSQLite = opts.useSQLite !== false && Database !== null;
    this._db = null;
    this._stmts = null; // SQLite statement güvenliği için null init
    if (wantSQLite) {
      const dbPath = this._paths.dbPath;
      const hasExistingDatabase = hasExistingPersistenceFile(dbPath);
      try {
        this._db = new Database(dbPath);
        this._initDB();
      } catch (e) {
        try { this._db?.close(); } catch (_) {}
        this._db = null;
        this._stmts = null;
        handleSqliteInitializationError(e, hasExistingDatabase, RECEIPT_FAMILY_MIGRATION_ERROR_CODE);
      }
    }
  }

  // ─── SQLite şema ──────────────────────────────────────────────────────────

  _initDB() {
    this._db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
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

    const edgeColumns = this._db.prepare('PRAGMA table_info(edges)').all().map(c => c.name);
    const nodeColumns = this._db.prepare('PRAGMA table_info(nodes)').all().map(c => c.name);
    const candidateColumns = this._db.prepare('PRAGMA table_info(candidate_claims)').all().map(c => c.name);
    const nodeSchemaRow = this._db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'nodes'").get();
    const nodeSchema = String(nodeSchemaRow?.sql || '');
    const nodeHasLegacyPrimaryKey = /id\s+TEXT\s+PRIMARY\s+KEY/i.test(nodeSchema) && !/PRIMARY\s+KEY\s*\(\s*workspace_id\s*,\s*id\s*\)/i.test(nodeSchema);
    let nodeSchemaMigrated = false;
    if (nodeHasLegacyPrimaryKey) {
      this._db.exec(`
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
    if (!nodeSchemaMigrated && !nodeColumns.includes('workspace_id')) this._db.exec("ALTER TABLE nodes ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default'");
    if (!nodeSchemaMigrated && !nodeColumns.includes('created_at')) this._db.exec("ALTER TABLE nodes ADD COLUMN created_at TEXT NOT NULL DEFAULT ''");
    if (!nodeSchemaMigrated && !nodeColumns.includes('last_seen')) this._db.exec("ALTER TABLE nodes ADD COLUMN last_seen TEXT NOT NULL DEFAULT ''");
    if (!nodeSchemaMigrated && !nodeColumns.includes('provenance')) this._db.exec("ALTER TABLE nodes ADD COLUMN provenance TEXT NOT NULL DEFAULT 'null'");
    if (!edgeColumns.includes('workspace_id')) this._db.exec("ALTER TABLE edges ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default'");
    if (!edgeColumns.includes('confidence')) this._db.exec('ALTER TABLE edges ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5');
    if (!edgeColumns.includes('source')) this._db.exec("ALTER TABLE edges ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
    if (!edgeColumns.includes('source_ref')) this._db.exec("ALTER TABLE edges ADD COLUMN source_ref TEXT NOT NULL DEFAULT ''");
    if (!edgeColumns.includes('session_id')) this._db.exec("ALTER TABLE edges ADD COLUMN session_id TEXT NOT NULL DEFAULT ''");
    if (!edgeColumns.includes('evidence')) this._db.exec("ALTER TABLE edges ADD COLUMN evidence TEXT NOT NULL DEFAULT '[]'");
    if (!edgeColumns.includes('evidence_type')) this._db.exec("ALTER TABLE edges ADD COLUMN evidence_type TEXT NOT NULL DEFAULT ''");
    if (!edgeColumns.includes('confidence_history')) this._db.exec("ALTER TABLE edges ADD COLUMN confidence_history TEXT NOT NULL DEFAULT '[]'");
    if (!edgeColumns.includes('company_mode')) this._db.exec("ALTER TABLE edges ADD COLUMN company_mode INTEGER NOT NULL DEFAULT 0");
    if (!edgeColumns.includes('source_type')) this._db.exec("ALTER TABLE edges ADD COLUMN source_type TEXT NOT NULL DEFAULT ''");
    if (!edgeColumns.includes('updated_at')) this._db.exec("ALTER TABLE edges ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''");
    if (!edgeColumns.includes('created_at')) this._db.exec("ALTER TABLE edges ADD COLUMN created_at TEXT NOT NULL DEFAULT ''");
    if (!edgeColumns.includes('strength')) this._db.exec('ALTER TABLE edges ADD COLUMN strength REAL NOT NULL DEFAULT 0.5');
    if (!edgeColumns.includes('provenance')) this._db.exec("ALTER TABLE edges ADD COLUMN provenance TEXT NOT NULL DEFAULT 'null'");
    if (!edgeColumns.includes('meta')) this._db.exec("ALTER TABLE edges ADD COLUMN meta TEXT NOT NULL DEFAULT '{}'");
    if (!candidateColumns.includes('candidate_id')) this._db.exec("ALTER TABLE candidate_claims ADD COLUMN candidate_id TEXT NOT NULL DEFAULT ''");
    if (!candidateColumns.includes('workspace_id')) this._db.exec("ALTER TABLE candidate_claims ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default'");
    if (!candidateColumns.includes('claim')) this._db.exec("ALTER TABLE candidate_claims ADD COLUMN claim TEXT NOT NULL DEFAULT ''");
    if (!candidateColumns.includes('proposed_edge')) this._db.exec("ALTER TABLE candidate_claims ADD COLUMN proposed_edge TEXT NOT NULL DEFAULT 'null'");
    if (!candidateColumns.includes('provenance')) this._db.exec("ALTER TABLE candidate_claims ADD COLUMN provenance TEXT NOT NULL DEFAULT 'null'");
    if (!candidateColumns.includes('conflict')) this._db.exec("ALTER TABLE candidate_claims ADD COLUMN conflict TEXT NOT NULL DEFAULT 'null'");
    if (!candidateColumns.includes('recommendation')) this._db.exec("ALTER TABLE candidate_claims ADD COLUMN recommendation TEXT NOT NULL DEFAULT 'accept'");
    if (!candidateColumns.includes('status')) this._db.exec("ALTER TABLE candidate_claims ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'");
    if (!candidateColumns.includes('created_at')) this._db.exec("ALTER TABLE candidate_claims ADD COLUMN created_at TEXT NOT NULL DEFAULT ''");
    if (!candidateColumns.includes('reviewed_at')) this._db.exec("ALTER TABLE candidate_claims ADD COLUMN reviewed_at TEXT NOT NULL DEFAULT ''");
    if (!candidateColumns.includes('reviewed_by')) this._db.exec("ALTER TABLE candidate_claims ADD COLUMN reviewed_by TEXT NOT NULL DEFAULT ''");
    if (!candidateColumns.includes('warnings')) this._db.exec("ALTER TABLE candidate_claims ADD COLUMN warnings TEXT NOT NULL DEFAULT '[]'");

    this._ensureMutationReceiptFamilySchema();

    this._db.exec(`
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

    // Prepared statements
    this._stmts = {
      upsertNode: this._db.prepare(`
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
      getNode: this._db.prepare('SELECT * FROM nodes WHERE id = ? AND workspace_id = ?'),
      deleteNode: this._db.prepare('DELETE FROM nodes WHERE id = ? AND workspace_id = ?'),
      deleteEdgesOf: this._db.prepare('DELETE FROM edges WHERE (from_id = ? OR to_id = ?) AND workspace_id = ?'),
      touchNode: this._db.prepare('UPDATE nodes SET last_accessed = ? WHERE id = ? AND workspace_id = ?'),
      upsertEdge: this._db.prepare(`
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
      getEdge: this._db.prepare('SELECT * FROM edges WHERE from_id = ? AND to_id = ? AND relation = ? AND workspace_id = ?'),
      getEdges: this._db.prepare('SELECT * FROM edges WHERE from_id = ? AND workspace_id = ?'),
      getInEdges: this._db.prepare('SELECT * FROM edges WHERE to_id = ? AND workspace_id = ?'),
      getCandidateClaim: this._db.prepare('SELECT * FROM candidate_claims WHERE candidate_id = ? AND workspace_id = ?'),
      allCandidateClaims: this._db.prepare('SELECT * FROM candidate_claims ORDER BY created_at ASC, candidate_id ASC'),
      upsertCandidateClaim: this._db.prepare(`
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
      pruneEdges: this._db.prepare('DELETE FROM edges WHERE weight < ? AND workspace_id = ?'),
      deleteEdge: this._db.prepare('DELETE FROM edges WHERE workspace_id = ? AND from_id = ? AND to_id = ? AND relation = ?'),
      countNodes: this._db.prepare('SELECT COUNT(*) as c FROM nodes'),
      countEdges: this._db.prepare('SELECT COUNT(*) as c FROM edges'),
      allNodes: this._db.prepare('SELECT * FROM nodes'),
      allEdges: this._db.prepare('SELECT * FROM edges'),
      updateEdgeWeight: this._db.prepare('UPDATE edges SET weight = ?, confidence = ?, source = ?, source_ref = ?, session_id = ?, evidence = ?, evidence_type = ?, confidence_history = ?, company_mode = ?, source_type = ?, updated_at = ?, provenance = ?, meta = ?, strength = ?, workspace_id = ? WHERE workspace_id = ? AND from_id = ? AND to_id = ? AND relation = ?'),
      updateNodeVector: this._db.prepare('UPDATE nodes SET vector = ? WHERE id = ? AND workspace_id = ?'),
      insertAuditEvent: this._db.prepare(`
        INSERT OR IGNORE INTO audit_log (
          audit_id, event_type, target_type, target_id, workspace_id, actor, timestamp,
          source_ref, provenance_id, trust_policy_version, details
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      allAuditEvents: this._db.prepare('SELECT * FROM audit_log ORDER BY timestamp ASC, audit_id ASC'),
      countAuditEvents: this._db.prepare('SELECT COUNT(*) AS total FROM audit_log'),
      getMutationJournal: this._db.prepare('SELECT operation_id, status, result, completed_at FROM mutation_journal WHERE operation_id = ?'),
      insertMutationJournal: this._db.prepare('INSERT INTO mutation_journal (operation_id, status, result, completed_at) VALUES (?, ?, ?, ?)'),
      getMutationReceiptByOperation: this._db.prepare('SELECT * FROM mutation_receipts WHERE operation_id = ?'),
      getMutationReceiptById: this._db.prepare('SELECT * FROM mutation_receipts WHERE receipt_id = ?'),
      getLatestMutationReceiptHash: this._db.prepare('SELECT receipt_hash FROM mutation_receipts WHERE workspace_id = ? AND receipt_family = ? ORDER BY sequence DESC LIMIT 1'),
      insertMutationReceipt: this._db.prepare('INSERT INTO mutation_receipts (operation_id, receipt_id, workspace_id, receipt_family, canonical_payload, previous_receipt_hash, receipt_hash, committed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    };
  }

  _ensureMutationReceiptFamilySchema() {
    return runMutationReceiptFamilySchema(this._db);
  }

  /**
   * JSON-backend durable mutation journal file, sibling to memoryPath (same
   * naming convention as _embeddingPath). Structure mirrors the SQLite
   * mutation_journal/mutation_receipts tables closely enough to reuse the
   * exact same receipt-chain logic (appendReceiptToChain/classifyReceiptFamily):
   *   { operations: { [operationId]: { status, result, receiptId, committedAt } },
   *     receipts:   { [operationId]: { receiptId, workspaceId, receiptFamily,
   *                                     canonicalPayload, previousReceiptHash,
   *                                     receiptHash, committedAt } },
   *     chainTips:  { [`${workspaceId}::${receiptFamily}`]: receiptHash },
   *     receiptsById: { [receiptId]: operationId } }
   */
  _jsonJournalPath() {
    return this._paths.journalPath;
  }

  _emptyJsonJournal() {
    return emptyMutationJournal();
  }

  /**
   * Fails closed on an existing-but-unreadable journal (#731); only a genuinely
   * absent journal yields empty history. See lib/mutation-journal.js.
   */
  _readJsonJournal() {
    return readMutationJournal(this._jsonJournalPath());
  }

  _writeJsonJournal(journal) {
    atomicWriteFileSync(this._jsonJournalPath(), JSON.stringify(journal));
  }
  _readMutationReceiptFromJsonJournal(journal, operationId) {
    return readMutationReceiptFromJsonJournal(journal, operationId);
  }

  _readMutationReceipt(row) {
    return readMutationReceipt(row);
  }

  getCommittedMutationReceiptByOperation(operationId) {
    return runReceiptByOperationRead(this._mutationReceiptReadStoreApi(), operationId);
  }

  getCommittedMutationReceiptById(receiptId) {
    return runReceiptByIdRead(this._mutationReceiptReadStoreApi(), receiptId);
  }

  _mutationReceiptReadStoreApi() {
    return {
      hasSqlite: () => Boolean(this._db && this._stmts),
      getMutationReceiptByOperation: id => this._stmts.getMutationReceiptByOperation.get(id),
      getMutationReceiptById: id => this._stmts.getMutationReceiptById.get(id),
      readJsonJournal: () => this._readJsonJournal(),
    };
  }
  getCommittedMutationResultByOperation(operationId) { return readCommittedMutationResult(this, operationId); } getCommittedMutationResultsByPrefix(prefix) { return readCommittedMutationResultsByPrefix(this, prefix); }
  runMutationOnce(operationId, mutate, opts = {}) {
    const id = typeof operationId === 'string' ? operationId.trim() : '';
    if (!id) throw new Error('mutation operationId is required');
    if (typeof mutate !== 'function') throw new TypeError('mutation callback is required');
    if (this._db && this._stmts) return this._runMutationOnceSqlite(id, mutate, opts);
    return this._runMutationOnceJson(id, mutate, opts);
  }

  /** Rollback pre-image + restore; see lib/graph-mutation-rollback.js (#1134). */
  _mutationRollbackSnapshot() {
    return createMutationRollbackSnapshot(
      { nodes: this._nodes, edges: this._edges, candidateClaims: this._candidateClaims, auditEvents: this._auditEvents },
      { cloneNodeMap, deepClone });
  }

  _restoreMutationRollbackSnapshot(snapshot) {
    return restoreMutationRollbackSnapshot({
      setNodes: nodes => { this._nodes = nodes; },
      setEdges: edges => { this._edges = edges; },
      setCandidateClaims: claims => { this._candidateClaims = claims; },
      truncateAuditEvents: count => { this._auditEvents.length = count; },
      rebuildIndexes: () => { this._outIndex.clear(); this._inIndex.clear(); this._rebuildIndex(); },
    }, snapshot);
  }

  _runMutationOnceSqlite(id, mutate, opts) {
    const readStored = () => {
      const row = this._stmts.getMutationJournal.get(id);
      return row && row.status === 'completed' ? JSON.parse(row.result) : null;
    };
    const stored = readStored();
    if (stored !== null) return { replayed: true, result: stored, receipt: this.getCommittedMutationReceiptByOperation(id) };

    const snapshot = this._mutationRollbackSnapshot();
    try {
      const execute = this._db.transaction(() => {
        const alreadyCompleted = readStored();
        if (alreadyCompleted !== null) return { replayed: true, result: alreadyCompleted, receipt: this.getCommittedMutationReceiptByOperation(id) };
        const result = mutate();
        let receipt = null;
        if (typeof opts.buildCanonicalReceipt === 'function') {
          const payload = opts.buildCanonicalReceipt(result);
          // null/undefined explicitly means "this mutation has no receipt"
          // (e.g. a bypass-mode learn with no admission decision) -- the
          // mutation still commits and journals, just without a receipt.
          // Anything else must be a valid canonical payload, or fail.
          if (payload !== null && payload !== undefined) {
            if (typeof payload !== 'object' || !payload.receiptId || !payload.workspaceId) {
              throw new Error('durable mutation receipt payload is invalid');
            }
            assertDurableV4WriteAllowed(payload, { operationId: id });
            const receiptFamily = classifyReceiptFamily(payload);
            const previous = this._stmts.getLatestMutationReceiptHash.get(payload.workspaceId, receiptFamily);
            const chained = appendReceiptToChain(payload, previous?.receipt_hash);
            const committedAt = nowIso();
            this._stmts.insertMutationReceipt.run(
              id, chained.receiptId, payload.workspaceId, receiptFamily, JSON.stringify(payload),
              chained.previousReceiptHash, chained.receiptHash, committedAt,
            );
            receipt = this._readMutationReceipt(this._stmts.getMutationReceiptByOperation.get(id));
          }
        }
        this._stmts.insertMutationJournal.run(id, 'completed', JSON.stringify(result), nowIso());
        return { replayed: false, result, receipt };
      });
      return execute();
    } catch (error) {
      // SQLite rolls back, but Graph also keeps mutable in-memory indexes.
      this._restoreMutationRollbackSnapshot(snapshot);
      const completed = readStored();
      if (completed !== null) {
        return { replayed: true, result: completed, receipt: this.getCommittedMutationReceiptByOperation(id) };
      }
      throw error;
    }
  }

  /**
   * JSON-backend counterpart to _runMutationOnceSqlite. Same external
   * contract ({replayed, result, receipt}), same idempotent-replay and
   * rollback-on-error guarantees, same receipt-chain logic (reuses
   * classifyReceiptFamily/appendReceiptToChain/assertDurableV4WriteAllowed
   * unchanged) -- durability comes from the journal file being written with
   * atomicWriteFileSync() (never a torn write) rather than a SQL transaction.
   */
  _runMutationOnceJson(id, mutate, opts) { return withMutationJournalLock(this._jsonJournalPath(), () => this._runMutationOnceJsonLocked(id, mutate, opts)); }
  _runMutationOnceJsonLocked(id, mutate, opts) {
    const readStored = () => {
      const journal = this._readJsonJournal();
      const op = journal.operations[id];
      return op && op.status === 'completed' ? { result: op.result, journal } : null;
    };

    const alreadyCompleted = readStored();
    if (alreadyCompleted !== null) {
      return {
        replayed: true,
        result: alreadyCompleted.result,
        receipt: this._readMutationReceiptFromJsonJournal(alreadyCompleted.journal, id),
      };
    }

    const snapshot = this._mutationRollbackSnapshot();
    try {
      // Re-check immediately before mutating (mirrors the SQLite path's
      // in-transaction re-check) to keep the replay race window minimal.
      const recheck = readStored();
      if (recheck !== null) {
        return {
          replayed: true,
          result: recheck.result,
          receipt: this._readMutationReceiptFromJsonJournal(recheck.journal, id),
        };
      }

      const result = mutate();
      const journal = this._readJsonJournal();
      let receipt = null;

      if (typeof opts.buildCanonicalReceipt === 'function') {
        const payload = opts.buildCanonicalReceipt(result);
        // null/undefined explicitly means "this mutation has no receipt"
        // (e.g. a bypass-mode learn with no admission decision) -- the
        // mutation still commits and journals, just without a receipt.
        if (payload !== null && payload !== undefined) {
          if (typeof payload !== 'object' || !payload.receiptId || !payload.workspaceId) {
            throw new Error('durable mutation receipt payload is invalid');
          }
          assertDurableV4WriteAllowed(payload, { operationId: id });
          const receiptFamily = classifyReceiptFamily(payload);
          const chainKey = `${payload.workspaceId}::${receiptFamily}`;
          // Re-checked here so a damaged tip is caught before it is linked
          // against, not after a broken chain has been written (#731).
          const previousReceiptHash = assertChainTipUsable(journal.chainTips, chainKey, this._jsonJournalPath());
          const chained = appendReceiptToChain(payload, previousReceiptHash);
          const committedAt = nowIso();
          journal.receipts[id] = {
            receiptId: chained.receiptId,
            workspaceId: payload.workspaceId,
            receiptFamily,
            canonicalPayload: payload,
            previousReceiptHash: chained.previousReceiptHash,
            receiptHash: chained.receiptHash,
            committedAt,
          };
          journal.receiptsById[chained.receiptId] = id;
          journal.chainTips[chainKey] = chained.receiptHash;
          receipt = this._readMutationReceiptFromJsonJournal(journal, id);
        }
      }

      journal.operations[id] = { status: 'completed', result, receiptId: receipt?.receiptId || null, committedAt: nowIso() };
      // Ordering matters: persist the actual graph state FIRST, and only
      // mark the journal 'completed' AFTER that succeeds. If save() were to
      // throw, in-memory state is rolled back below -- if the journal had
      // already been marked 'completed' at that point, a replay would
      // return a "success" result for data that was never actually
      // persisted (phantom completion, real data loss). Reversing this
      // (journal first) trades that for a smaller, opposite risk: if the
      // journal write itself fails right after a successful save(), a
      // retry with the same operationId would re-run an already-applied
      // mutation. A rare possible double-apply is the lesser failure mode
      // than ever falsely claiming a mutation completed.
      this.save();
      this._writeJsonJournal(journal);

      // persisted: true tells the caller save() already happened as part of
      // committing this mutation (unlike the SQLite path, where the DB
      // transaction is the persistence and a caller-side save() afterward
      // additionally syncs the JSON fallback export) -- so a caller that
      // unconditionally saves after every non-replayed outcome can skip
      // that redundant second save for the JSON backend specifically.
      return { replayed: false, result, receipt, persisted: true };
    } catch (error) {
      this._restoreMutationRollbackSnapshot(snapshot);
      const completed = readStored();
      if (completed !== null) {
        return { replayed: true, result: completed.result, receipt: this._readMutationReceiptFromJsonJournal(completed.journal, id) };
      }
      throw error;
    }
  }

  // ─── Node işlemleri ───────────────────────────────────────────────────────

  _assignEmbedding(storageKey, embedding) {
    this._nodes[storageKey].embedding = embedding;
  }

  /** Edge-touch scope + temporal stamping; see lib/graph-edge-mutations.js (#733). */
  _captureTemporalEdgeKeys() {
    this._edgeTouchScope = beginEdgeTouchScope(this);
    return this._edgeTouchScope;
  }

  _recordEdgeTouch(workspaceId, from, relation, to) {
    if (this._edgeTouchScope) this._edgeTouchScope.touched.add(edgeTouchKey(workspaceId, from, relation, to));
  }

  _applyTemporalEdgeMetadata(source, learnedAt, scope, opts = {}) {
    this._edgeTouchScope = null;
    return applyTemporalEdgeMetadata(this, { source, learnedAt, scope, workspaceId: opts.workspaceId });
  }

  /** Canonical downgrade/reclassify write path; see lib/graph-edge-mutations.js (#732). */
  downgradeEdge(spec = {}) {
    return downgradeEdge(this, spec);
  }

  _consolidateEdges(dryRun = true) {
    return consolidateEdges({ edges: this._edges, dryRun, replaceEdges: arr => { this._edges = arr; }, rebuildIndex: () => this._rebuildIndex(), save: () => this.save(), logSaveError: error => { console.error('[Kernel] Graph save hatası:', error.message); }, auditRemoval: (edge, reason) => this.appendAuditEvent({ eventType: 'DELETE', targetType: 'edge', targetId: `${edge.from}|${edge.relation}|${edge.to}`, workspaceId: normalizeWorkspaceId(edge.workspaceId), actor: 'graph.consolidate', sourceRef: 'graph.consolidate', details: { reason, weight: edge.weight } }) });
  }

  getNodes(workspaceId = 'default') {
    return runNodesRead(this._nodes, workspaceId);
  }

  _nodeWriteStoreApi() {
    return {
      readPersisted: (id, workspaceId) => {
        if (this._db && this._stmts) {
          return { enabled: true, existing: this._stmts.getNode.get(id, workspaceId) };
        }
        return { enabled: false, existing: null };
      },
      get: storageKey => this._nodes[storageKey],
      set: (storageKey, value) => { this._nodes[storageKey] = value; },
      persist: ({ id, workspaceId, label, weight, created, createdAt, lastAccessed, lastSeen, vector, provenance }) => {
        this._stmts.upsertNode.run(
          id,
          workspaceId,
          label,
          weight,
          created,
          createdAt,
          lastAccessed,
          lastSeen,
          vector,
          provenance,
        );
      },
    };
  }

  addNode(id, label, provenance = null, opts = {}) {
    return runNodeWrite(this._nodeWriteStoreApi(), id, label, provenance, opts);
  }

  getNode(id, workspaceId = 'default') {
    return runNodeRead(this._nodes, id, workspaceId);
  }

  _nodeTouchStoreApi() { return {
    get: storageKey => this._nodes[storageKey],
    persist: (accessedAt, id, workspaceId) => this._db && this._stmts && this._stmts.touchNode.run(accessedAt, id, workspaceId),
  }; }

  touchNode(id, workspaceId = 'default') {
    return runNodeTouch(this._nodeTouchStoreApi(), id, workspaceId);
  }

  appendAuditEvent(event, opts = {}) {
    const normalized = buildAuditEvent(event, opts);
    this._auditEvents.push(normalized);
    if (this._db && this._stmts) {
      this._stmts.insertAuditEvent.run(
        normalized.auditId,
        normalized.eventType,
        normalized.targetType || '',
        normalized.targetId || '',
        normalized.workspaceId || 'default',
        normalized.actor || 'system',
        normalized.timestamp,
        normalized.sourceRef || '',
        normalized.provenanceId || '',
        normalized.trustPolicyVersion || '',
        JSON.stringify(normalized.details ?? {}),
      );
    }
    return normalized;
  }

  _auditQueryContext() {
    return {
      db: this._db,
      stmts: this._stmts,
      events: this._auditEvents,
      statementCache: this._auditQueryStmts,
    };
  }

  getAuditEvents(filters = {}) {
    return readAuditEvents(this._auditQueryContext(), filters);
  }

  /** Bounded COUNT(*); see lib/audit-query.js (#728). */
  countAuditEvents(filters = {}) {
    return countAuditEvents(this._auditQueryContext(), filters);
  }

  /** One keyset page with filters pushed into SQL; see lib/audit-query.js (#729). */
  queryAuditEvents(options = {}) {
    return queryAuditEvents(this._auditQueryContext(), options);
  }

  _candidateClaimWriteStoreApi() {
    return {
      findIndex: (candidateId, workspaceId) => this._candidateClaims.findIndex(item =>
        item.candidateId === candidateId && normalizeWorkspaceId(item.workspaceId) === workspaceId
      ),
      get: index => this._candidateClaims[index],
      replace: (index, value) => { this._candidateClaims[index] = value; },
      append: value => { this._candidateClaims.push(value); },
      persist: (normalized, workspaceId) => {
        if (this._db && this._stmts) {
          this._stmts.upsertCandidateClaim.run(
            normalized.candidateId,
            workspaceId,
            normalized.claim || '',
            JSON.stringify(normalized.proposedEdge ?? null),
            JSON.stringify(normalized.provenance ?? null),
            JSON.stringify(normalized.conflict ?? null),
            normalized.recommendation || 'accept',
            normalized.status || 'pending',
            normalized.createdAt || nowIso(),
            normalized.reviewedAt || '',
            normalized.reviewedBy || '',
            JSON.stringify(normalized.warnings || []),
          );
        }
      },
      read: filters => runCandidateClaimsRead(this._candidateClaims, filters),
    };
  }

  addCandidateClaim(candidate, opts = {}) {
    return runCandidateClaimWrite(this._candidateClaimWriteStoreApi(), candidate, opts);
  }

  getCandidateClaims(filters = {}) {
    return runCandidateClaimsRead(this._candidateClaims, filters);
  }

  _nodeDeleteStoreApi() { return {
    getNode: (id, workspaceId) => this.getNode(id, workspaceId),
    deleteNode: storageKey => delete this._nodes[storageKey],
    removeIncidentEdges: (id, workspaceId) => (this._edges = this._edges.filter(edge => !(edge.workspaceId === workspaceId && (edge.from === id || edge.to === id)))),
    rebuildIndex: () => this._rebuildIndex(),
    persistDeleteEdges: (id, workspaceId) => this._db && this._stmts && this._stmts.deleteEdgesOf.run(id, id, workspaceId),
    persistDeleteNode: (id, workspaceId) => this._db && this._stmts && this._stmts.deleteNode.run(id, workspaceId),
  }; }

  removeNode(id, workspaceId = 'default') {
    return runNodeDelete(this._nodeDeleteStoreApi(), id, workspaceId);
  }

  getWeight(id, workspaceId = 'default') {
    return runNodeWeight((nodeId, scope) => this.getNode(nodeId, scope), this._decayLambda, id, workspaceId);
  }

  _nodeTagStoreApi() { return { get: storageKey => this._nodes[storageKey] }; }

  addTag(nodeId, dim, weight, workspaceId = 'default') {
    return runNodeTag(this._nodeTagStoreApi(), nodeId, dim, weight, workspaceId);
  }

  // ─── Edge işlemleri ───────────────────────────────────────────────────────

  _edgeWriteStoreApi() {
    return {
      hasNode: (id, workspaceId) => Boolean(this.getNode(id, workspaceId)),
      touchNode: (id, workspaceId) => this.touchNode(id, workspaceId),
      findExisting: (fromId, toId, relation, workspaceId) => (
        (this._outIndex.get(edgeIndexKey(fromId, workspaceId)) || []).find(
          edge => edge.to === toId
            && edge.relation === relation
            && normalizeWorkspaceId(edge.workspaceId) === workspaceId
        ) || null
      ),
      append: edge => {
        this._edges.push(edge);
        this._indexEdge(edge);
      },
      persistUpdate: (edge, workspaceId, fromId, toId, relation, isoNow) => {
        if (!this._db || !this._stmts) return;
        this._stmts.updateEdgeWeight.run(
          ...edgeUpdateArgs(edge, workspaceId, fromId, toId, relation, isoNow),
        );
      },
      persistCreate: (edge, workspaceId, fromId, toId, relation, isoNow) => {
        if (!this._db || !this._stmts) return;
        this._stmts.upsertEdge.run(
          workspaceId,
          fromId,
          toId,
          relation,
          edge.weight,
          edge.confidence,
          edge.source,
          edge.source_ref || '',
          edge.session_id || '',
          JSON.stringify(edge.evidence || []),
          edge.evidence_type || '',
          JSON.stringify(edge.confidence_history || []),
          edge.company_mode ? 1 : 0,
          edge.source_type || '',
          edge.updated_at || isoNow,
          edge.created_at || isoNow,
          JSON.stringify(edge.provenance ?? null),
          JSON.stringify(edge.meta ?? {}),
          edge.created,
          edge.strength ?? 0.5,
        );
      },
      recordTouch: (workspaceId, fromId, relation, toId) => {
        this._recordEdgeTouch(workspaceId, fromId, relation, toId);
      },
    };
  }

  addEdge(fromId, toId, relation, opts = {}) {
    return runEdgeWrite(this._edgeWriteStoreApi(), fromId, toId, relation, opts);
  }

  getEdge(fromId, toId, relation, workspaceId = 'default') {
    return runEdgeRead(this._outIndex, fromId, toId, relation, workspaceId);
  }

  getEdgesBetween(fromId, toId, workspaceId = 'default') {
    return runEdgesBetweenRead(this._outIndex, fromId, toId, workspaceId);
  }

  hasAnyEdge(fromId, toId, workspaceId = 'default') {
    return runHasAnyEdgeRead(this._outIndex, fromId, toId, workspaceId);
  }

  getEdges(nodeId, workspaceId = 'default') {
    return runEdgesRead(this._outIndex, nodeId, workspaceId);
  }

  getInEdges(nodeId, workspaceId = 'default') {
    return runInEdgesRead(this._inIndex, nodeId, workspaceId);
  }

  /** All edges in a workspace, independent of any single node. */
  getAllEdges(workspaceId = 'default') {
    return runAllEdgesRead(this._edges, workspaceId);
  }

  query(label, workspaceId = 'default') {
    return runGraphQuery(this._nodes, label, workspaceId);
  }

  nodeCount(workspaceId) {
    return runNodeCount(this._nodes, workspaceId);
  }
  edgeCount(workspaceId) {
    return runEdgeCount(this._edges, workspaceId);
  }

  cosineSimilarity(aId, bId, workspaceId = 'default') {
    return runNodeSimilarity((nodeId, scope) => this.getNode(nodeId, scope), aId, bId, workspaceId);
  }

  _pruneStoreApi() { return { getEdges: () => this._edges, setEdges: edges => { this._edges = edges; }, rebuildIndex: () => this._rebuildIndex(), getPruneThreshold: () => this._pruneThreshold, persistPrune: (threshold, scope) => { if (this._db) this._stmts.pruneEdges.run(threshold, scope); } }; }

  prune(threshold, workspaceId = 'default') {
    return runGraphPrune(this._pruneStoreApi(), threshold, workspaceId);
  }

  _optimizeStoreApi() { return { prune: scope => this.prune(undefined, scope), getNodes: () => this._nodes, getEdges: (nodeId, scope) => this.getEdges(nodeId, scope), getInEdges: (nodeId, scope) => this.getInEdges(nodeId, scope), decayLambda: this._decayLambda, deleteNode: id => { delete this._nodes[id]; }, persistDeleteNode: (id, scope) => { if (this._db && this._stmts) this._stmts.deleteNode.run(id, scope); }, auditRemoval: (node, decayedWeight) => this.appendAuditEvent({ eventType: 'DELETE', targetType: 'node', targetId: node.id, workspaceId: normalizeWorkspaceId(node.workspaceId), actor: 'graph.optimize', sourceRef: 'graph.optimize', details: { reason: 'decayed_isolated_node', decayedWeight } }) }; }

  optimize(workspaceId = 'default') {
    return runGraphOptimize(this._optimizeStoreApi(), workspaceId);
  }

  _statsStoreApi() { return { nodeCount: () => this.nodeCount(), edgeCount: () => this.edgeCount(), candidateClaims: this._candidateClaims, decayLambda: this._decayLambda, hasSqlite: Boolean(this._db) }; }

  getStats() {
    return runGraphStats(this._statsStoreApi());
  }

  // ─── Kalıcılık ────────────────────────────────────────────────────────────

  _stripEmbeddings() {
    const embeddings = {};
    for (const [id, node] of Object.entries(this._nodes)) {
      if (node.embedding) {
        embeddings[id] = Array.from(node.embedding);
        delete node.embedding;
      }
    }
    return embeddings;
  }

  _restoreEmbeddings(embeddings) {
    for (const [id, vec] of Object.entries(embeddings)) {
      if (this._nodes[id]) {
        this._nodes[id].embedding = new Float64Array(vec);
      } else {
        const [workspaceId, nodeId] = id.includes('::') ? id.split('::') : ['default', id];
        const storageKey = nodeStorageKey(nodeId, workspaceId);
        if (this._nodes[storageKey]) {
          this._nodes[storageKey].embedding = new Float64Array(vec);
        }
      }
    }
  }

  save() {
    // #369: strip -> write -> restore has to be crash-safe. _stripEmbeddings()
    // deletes node.embedding from the *live* in-memory nodes so the serialized
    // form stays JSON-clean, which means that between here and the restore the
    // only copy of those vectors is the local `embeddings` map. Restoring in a
    // finally makes a failed save() degrade to "not persisted" rather than
    // "not persisted AND erased from memory".
    const embeddings = this._stripEmbeddings();
    try {
      this._writeStrippedState(embeddings);
    } finally {
      this._restoreEmbeddings(embeddings);
    }
  }

  // Split out of save() purely so the restore above can live in a finally
  // without reindenting the entire write path.
  _writeStrippedState(embeddings) {
    if (this._db && this._stmts) {
      // SQLite: toplu yazma (transaction)
      const saveAll = this._db.transaction(() => {
        for (const node of Object.values(this._nodes)) {
          this._db.prepare(`
            INSERT INTO nodes (id, workspace_id, label, weight, created, created_at, last_accessed, last_seen, vector, provenance)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(workspace_id, id) DO UPDATE SET
              workspace_id = excluded.workspace_id,
              label = excluded.label,
              weight = excluded.weight,
              last_accessed = excluded.last_accessed,
              last_seen = excluded.last_seen,
              vector = excluded.vector,
              provenance = excluded.provenance
          `).run(
            node.id, normalizeWorkspaceId(node.workspaceId), node.label, node.weight,
            node.created,
            node.created_at || nowIso(),
            node.lastAccessed,
            node.last_seen || node.lastSeen || nowIso(),
            JSON.stringify(node.vector || {}),
            JSON.stringify(node.provenance ?? null)
          );
        }
        for (const edge of this._edges) {
          // The shared `upsertEdge` statement, not a second copy of it.
          //
          // This loop used to inline its own INSERT ... ON CONFLICT whose
          // column list had drifted from `_initDB`'s: `strength` was absent
          // from both the columns and the DO UPDATE SET, so save() could not
          // repair a strength the update path had already failed to write.
          // Two UPSERTs over one table is what let them diverge (#1024).
          this._stmts.upsertEdge.run(
            normalizeWorkspaceId(edge.workspaceId),
            edge.from,
            edge.to,
            edge.relation,
            edge.weight,
            edge.confidence ?? edge.weight ?? 0.5,
            edge.source || 'manual',
            edge.source_ref || '',
            edge.session_id || '',
            JSON.stringify(edge.evidence || []),
            edge.evidence_type || '',
            JSON.stringify(edge.confidence_history || []),
            edge.company_mode ? 1 : 0,
            edge.source_type || '',
            edge.updated_at || nowIso(),
            edge.created_at || nowIso(),
            JSON.stringify(edge.provenance ?? null),
            JSON.stringify(edge.meta ?? {}),
            edge.created,
            edge.strength ?? 0.5
          );
        }
        for (const candidate of this._candidateClaims) {
          this._stmts.upsertCandidateClaim.run(
            candidate.candidateId,
            normalizeWorkspaceId(candidate.workspaceId),
            candidate.claim || '',
            JSON.stringify(candidate.proposedEdge ?? null),
            JSON.stringify(candidate.provenance ?? null),
            JSON.stringify(candidate.conflict ?? null),
            candidate.recommendation || 'accept',
            candidate.status || 'pending',
            candidate.createdAt || nowIso(),
            candidate.reviewedAt || '',
            candidate.reviewedBy || '',
            JSON.stringify(candidate.warnings || []),
          );
        }
        for (const event of this._auditEvents) {
          this._stmts.insertAuditEvent.run(
            event.auditId,
            event.eventType,
            event.targetType || '',
            event.targetId || '',
            event.workspaceId || 'default',
            event.actor || 'system',
            event.timestamp,
            event.sourceRef || '',
            event.provenanceId || '',
            event.trustPolicyVersion || '',
            JSON.stringify(event.details ?? {}),
          );
        }
      });
      saveAll();
    }

    // JSON de yaz (Rust katmanı ve fallback için) — atomik: crash mid-write
    // memoryPath'i asla yarım/bozuk bırakmaz (eski içerik ya da yeni içerik,
    // ikisinin karışımı asla).
    const data = {
      nodes: this._nodes,
      edges: this._edges,
      candidateClaims: this._candidateClaims,
      auditEvents: this._auditEvents,
    };
    atomicWriteFileSync(this.memoryPath, JSON.stringify(data));

    // Embedding'leri ayrı dosyaya yaz (aynı atomik garanti). Geri koyma işi
    // save()'in finally'sinde: buradaki bir hata da embedding'leri bellekte
    // bırakmalı (#369).
    //
    // #609: koşulsuz yazılır. Eskiden yalnızca en az bir embedding varken
    // yazılıyordu, dolayısıyla son embedding silindiğinde (ya da prune() node'u
    // düşürdüğünde) eski sidecar diskte kalıyor ve bir sonraki load() silinmiş
    // vektörü geri diriltiyordu. Sidecar memory.json'ın parçası gibi
    // davranmalı: her save() onu son duruma eşitler, boş obje dahil.
    atomicWriteFileSync(this._embeddingPath, JSON.stringify(embeddings));
  }

  load() {
    this._nodes = {};
    this._edges = [];
    this._candidateClaims = [];
    this._auditEvents = [];
    this._outIndex.clear();
    this._inIndex.clear();

    if (this._db && this._stmts) {
      // SQLite'tan yükle
      try {
        const nodes = this._stmts.allNodes.all();
        const edges = this._stmts.allEdges.all();
        const candidateRows = this._stmts.allCandidateClaims.all();
        const auditRows = this._stmts.allAuditEvents.all();

        if (nodes.length > 0 || edges.length > 0 || auditRows.length > 0 || candidateRows.length > 0) {
          this._nodes = {};
          for (const row of nodes) {
            const node = normalizeNodeRecord({
              id: row.id,
              workspaceId: row.workspace_id || 'default',
              label: row.label,
              weight: row.weight,
              created: row.created,
              created_at: row.created_at || '',
              lastAccessed: row.last_accessed,
              last_seen: row.last_seen || '',
              vector: JSON.parse(row.vector || '{}'),
              provenance: JSON.parse(row.provenance || 'null'),
            });
            this._nodes[nodeStorageKey(node.id, node.workspaceId)] = {
              ...node,
              lastAccessed: row.last_accessed,
            };
          }
          this._edges = edges.map(row => normalizeLoadedEdge({
            workspaceId: row.workspace_id || 'default',
            from: row.from_id,
            to: row.to_id,
            relation: row.relation,
            weight: row.weight,
            confidence: row.confidence ?? row.weight ?? 0.5,
            source: row.source || 'manual',
            source_ref: row.source_ref || '',
            session_id: row.session_id || '',
            evidence: JSON.parse(row.evidence || '[]'),
            evidence_type: row.evidence_type || '',
            confidence_history: JSON.parse(row.confidence_history || '[]'),
            company_mode: Number(row.company_mode || 0),
              source_type: row.source_type || '',
              updated_at: row.updated_at || '',
              created_at: row.created_at || '',
              provenance: JSON.parse(row.provenance || 'null'),
              meta: JSON.parse(row.meta || '{}'),
              created: row.created,
              strength: row.strength,
            }));
          this._candidateClaims = candidateRows.map(row => normalizeCandidateClaim({
            candidateId: row.candidate_id,
            workspaceId: row.workspace_id || 'default',
            claim: row.claim || '',
            proposedEdge: JSON.parse(row.proposed_edge || 'null'),
            provenance: JSON.parse(row.provenance || 'null'),
            conflict: JSON.parse(row.conflict || 'null'),
            recommendation: row.recommendation || 'accept',
            status: row.status || 'pending',
            createdAt: row.created_at || '',
            reviewedAt: row.reviewed_at || '',
            reviewedBy: row.reviewed_by || '',
            warnings: JSON.parse(row.warnings || '[]'),
          }));
          this._auditEvents = auditRows.map(row => normalizeAuditEvent({
            auditId: row.audit_id,
            eventType: row.event_type,
            targetType: row.target_type || '',
            targetId: row.target_id || '',
            workspaceId: row.workspace_id || 'default',
            actor: row.actor || 'system',
            timestamp: row.timestamp,
            sourceRef: row.source_ref || '',
            provenanceId: row.provenance_id || '',
            trustPolicyVersion: row.trust_policy_version || '',
            details: JSON.parse(row.details || '{}'),
          }));
          this._rebuildIndex();

          // Embedding'leri yükle
          if (fs.existsSync(this._embeddingPath)) {
            const emb = JSON.parse(fs.readFileSync(this._embeddingPath, 'utf-8'));
            this._restoreEmbeddings(emb);
          }
          return; // SQLite'tan başarıyla yüklendi
        }
      } catch (e) {
        throw sqlitePersistenceError('load', e);
      }
    }

    // JSON fallback
    if (!fs.existsSync(this.memoryPath)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.memoryPath, 'utf-8'));
      this._nodes = {};
      for (const [key, node] of Object.entries(data.nodes || {})) {
        const normalized = normalizeNodeRecord(node, key);
        this._nodes[nodeStorageKey(normalized.id, normalized.workspaceId)] = normalized;
      }
      this._edges = (data.edges || []).map(edge => normalizeLoadedEdge(edge));
      this._candidateClaims = (data.candidateClaims || data.candidate_claims || []).map(candidate => normalizeCandidateClaim(candidate));
      this._auditEvents = (data.auditEvents || data.audit_log || []).map(event => normalizeAuditEvent(event));
      this._rebuildIndex();

      if (fs.existsSync(this._embeddingPath)) {
        try {
          const emb = JSON.parse(fs.readFileSync(this._embeddingPath, 'utf-8'));
          this._restoreEmbeddings(emb);
        } catch (_) {}
      }

      // JSON'dan yüklendiyse SQLite'a migrate et
      if (this._db && Object.keys(this._nodes).length > 0) {
        this.save(); // SQLite'a yaz
      }
    } catch (e) {
      console.error('Load error:', e.message);
    }
  }

  // ─── Index yönetimi ───────────────────────────────────────────────────────

  _indexEdge(edge) {
    const outKey = edgeIndexKey(edge.from, edge.workspaceId);
    const inKey = edgeIndexKey(edge.to, edge.workspaceId);
    if (!this._outIndex.has(outKey)) this._outIndex.set(outKey, []);
    this._outIndex.get(outKey).push(edge);
    if (!this._inIndex.has(inKey)) this._inIndex.set(inKey, []);
    this._inIndex.get(inKey).push(edge);
  }

  _rebuildIndex() {
    this._outIndex.clear();
    this._inIndex.clear();
    for (const e of this._edges) this._indexEdge(e);
  }

  // ─── Causal relation helpers for v0.7 ───────────────────────────────────────

  isCausalRelation(relation) {
    return runIsCausalRelation(CAUSAL_RELATIONS, relation);
  }

  getCausalRelations() {
    return runCausalRelations(CAUSAL_RELATIONS);
  }

  getCausalEdges(fromId, workspaceId = 'default') {
    return runCausalEdges((id, scope) => this.getEdges(id, scope), CAUSAL_RELATIONS, compareCausalEdges, fromId, workspaceId);
  }

  getCausalChain(fromId, maxDepthOrOpts = 10) {
    return runCausalChain(this, fromId, maxDepthOrOpts);
  }

  // ─── Temizlik ─────────────────────────────────────────────────────────────

  close() {
    if (this._db && this._stmts) {
      try { this._db.close(); } catch (_) {}
      this._db = null;
    }
  }
}

module.exports = Graph;
module.exports.Graph = Graph;
module.exports.CAUSAL_RELATIONS = CAUSAL_RELATIONS;
module.exports.STANDARD_RELATIONS = STANDARD_RELATIONS;
