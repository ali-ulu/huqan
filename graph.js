const fs = require('fs');
const path = require('path');
const { buildAuditEvent, getAuditEvents: filterAuditEvents, normalizeAuditEvent } = require('./lib/audit-log');
const { normalizeCandidateClaim } = require('./lib/conflict-detector');

// SQLite opsiyonel — yoksa JSON fallback
let Database;
try { Database = require('better-sqlite3'); } catch (_) { Database = null; }

// Causal relation types for v0.7
const CAUSAL_RELATIONS = Object.freeze([
  'CAUSES',      // Neden olur
  'PREVENTS',    // Engelleyen
  'ENABLES',     // Mümkün kılan
  'DEPENDS_ON',  // Bağımlı olduğu
  'LEADS_TO',    // Sonuçlanan
]);

const STANDARD_RELATIONS = Object.freeze([
  'is_a',
  'has_property',
  'related_to',
  ...CAUSAL_RELATIONS,
]);

const EDGE_META_NAMESPACE = 'entityResolution';
const EDGE_META_MAX_BYTES = 4096;

const CAUSAL_RELATION_PRIORITY = Object.freeze({
  CAUSES: 0,
  ENABLES: 1,
  LEADS_TO: 2,
  DEPENDS_ON: 3,
  PREVENTS: 4,
});

function normalizeWorkspaceId(value, fallback = 'default') {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return fallback;
}

function nodeStorageKey(id, workspaceId = 'default') {
  const scope = normalizeWorkspaceId(workspaceId);
  return scope === 'default' ? id : `${scope}::${id}`;
}

function edgeIndexKey(id, workspaceId = 'default') {
  return nodeStorageKey(id, workspaceId);
}

function normalizeNodeRecord(node = {}, fallbackKey = '') {
  const workspaceId = normalizeWorkspaceId(node.workspaceId || node.workspace_id || 'default');
  const id = node.id || fallbackKey.split('::').pop() || '';
  const createdAt = node.created_at || (typeof node.created === 'number' ? new Date(node.created).toISOString() : '');
  const lastSeen = node.last_seen || node.lastSeen || createdAt || nowIso();
  return {
    ...node,
    id,
    workspaceId,
    created_at: createdAt,
    last_seen: lastSeen,
    lastSeen,
    provenance: deepClone(node.provenance),
    vector: isPlainObject(node.vector) ? deepClone(node.vector) : {},
    tags: Array.isArray(node.tags) ? [...node.tags] : [],
  };
}

function nowIso() {
  return new Date().toISOString();
}

function deepClone(value) {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

function cloneNodeRecord(node) {
  if (!node) return null;
  return {
    ...node,
    tags: Array.isArray(node.tags) ? [...node.tags] : [],
    vector: isPlainObject(node.vector) ? deepClone(node.vector) : {},
    provenance: deepClone(node.provenance),
  };
}

function cloneEdgeRecord(edge) {
  if (!edge) return null;
  return {
    ...edge,
    evidence: Array.isArray(edge.evidence) ? [...edge.evidence] : [],
    confidence_history: Array.isArray(edge.confidence_history) ? deepClone(edge.confidence_history) : [],
    provenance: deepClone(edge.provenance),
    meta: deepClone(edge.meta) ?? {},
  };
}

function clamp01(value, fallback = 0.5) {
  const fallbackNumber = Number.isFinite(Number(fallback)) ? Number(fallback) : 0.5;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Math.max(0, Math.min(1, fallbackNumber));
  return Math.max(0, Math.min(1, numeric));
}

function edgeSortKey(edge) {
  return [
    edge.from || '',
    edge.to || '',
    edge.relation || '',
    edge.source_ref || '',
    edge.session_id || '',
    edge.created_at || '',
    String(edge.created || ''),
  ].join('|');
}

function compareCausalEdges(a, b) {
  const relationPriorityDiff =
    (CAUSAL_RELATION_PRIORITY[a.relation] ?? 99) -
    (CAUSAL_RELATION_PRIORITY[b.relation] ?? 99);
  if (relationPriorityDiff !== 0) return relationPriorityDiff;

  const strengthDiff = (b.strength ?? 0.5) - (a.strength ?? 0.5);
  if (strengthDiff !== 0) return strengthDiff;

  const confidenceDiff = (b.confidence ?? 0.5) - (a.confidence ?? 0.5);
  if (confidenceDiff !== 0) return confidenceDiff;

  const createdAtDiff = String(a.created_at || '').localeCompare(String(b.created_at || ''));
  if (createdAtDiff !== 0) return createdAtDiff;

  return edgeSortKey(a).localeCompare(edgeSortKey(b));
}

function normalizeCausalStep(edge) {
  const step = {
    from: edge.from,
    to: edge.to,
    relation: edge.relation,
    strength: edge.strength ?? 0.5,
    confidence: edge.confidence ?? edge.weight ?? 0.5,
    source: edge.source || 'manual',
    source_ref: edge.source_ref || '',
    session_id: edge.session_id || '',
    evidence: Array.isArray(edge.evidence) ? edge.evidence : [],
    evidence_type: edge.evidence_type || '',
    created_at: edge.created_at || '',
    updated_at: edge.updated_at || '',
  };

  if (typeof edge.created === 'number') {
    step.created = edge.created;
  }

  return step;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeEdgeMeta(meta) {
  if (!isPlainObject(meta)) return {};
  const candidate = {};
  if (Object.prototype.hasOwnProperty.call(meta, EDGE_META_NAMESPACE) && isPlainObject(meta[EDGE_META_NAMESPACE])) {
    try {
      candidate[EDGE_META_NAMESPACE] = JSON.parse(JSON.stringify(meta[EDGE_META_NAMESPACE]));
      const bytes = Buffer.byteLength(JSON.stringify(candidate), 'utf8');
      if (bytes > EDGE_META_MAX_BYTES) return {};
      return candidate;
    } catch (_) {
      return {};
    }
  }
  return {};
}

function attachTraversalMeta(chain, meta) {
  Object.defineProperties(chain, {
    start: { value: meta.start, enumerable: true },
    chain: { value: chain, enumerable: true },
    visited: { value: meta.visited, enumerable: true },
    loops: { value: meta.loops, enumerable: true },
    stoppedReason: { value: meta.stoppedReason, enumerable: true },
    maxDepth: { value: meta.maxDepth, enumerable: true },
    confidence: { value: meta.confidence, enumerable: true },
  });
  return chain;
}

function normalizeLoadedEdge(edge) {
  const normalized = {
    ...edge,
    weight: clamp01(edge.weight, 0.5),
    confidence: clamp01(edge.confidence, clamp01(edge.weight, 0.5)),
    source: edge.source || 'manual',
    source_ref: edge.source_ref || '',
    session_id: edge.session_id || '',
    evidence: Array.isArray(edge.evidence) ? edge.evidence : [],
    evidence_type: edge.evidence_type || '',
    confidence_history: Array.isArray(edge.confidence_history) ? edge.confidence_history : [],
    company_mode: Number(edge.company_mode || 0),
    source_type: edge.source_type || '',
    updated_at: edge.updated_at || '',
    created_at: edge.created_at || '',
    provenance: deepClone(edge.provenance),
    meta: sanitizeEdgeMeta(edge.meta),
    workspaceId: edge.workspaceId || edge.workspace_id || 'default',
  };

  if (CAUSAL_RELATIONS.includes(normalized.relation)) {
    normalized.strength = typeof normalized.strength === 'number' ? normalized.strength : 0.5;
  } else if ('strength' in normalized) {
    delete normalized.strength;
  }

  return normalized;
}

function cloneAuditEvent(event) {
  return normalizeAuditEvent({
    auditId: event.auditId,
    eventType: event.eventType,
    targetType: event.targetType,
    targetId: event.targetId,
    workspaceId: event.workspaceId,
    actor: event.actor,
    timestamp: event.timestamp,
    sourceRef: event.sourceRef,
    provenanceId: event.provenanceId,
    trustPolicyVersion: event.trustPolicyVersion,
    details: event.details,
  });
}

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
    this._embeddingPath = this.memoryPath.replace(/\.json$/, '.embeddings.json');
    this._decayLambda = opts.decayLambda || 0.05;
    this._pruneThreshold = opts.pruneThreshold || 0.01;
    this._nodes = {};
    this._edges = [];
    this._candidateClaims = [];
    this._auditEvents = [];
    this._outIndex = new Map();
    this._inIndex = new Map();

    // SQLite kurulumu
    const wantSQLite = opts.useSQLite !== false && Database !== null;
    this._db = null;
    this._stmts = null; // SQLite statement güvenliği için null init
    if (wantSQLite) {
      const dbPath = opts.dbPath || this.memoryPath.replace(/\.json$/, '.db');
      try {
        this._db = new Database(dbPath);
        this._initDB();
      } catch (e) {
        console.error('[Graph] SQLite başlatılamadı, JSON fallback:', e.message);
        this._db = null;
        this._stmts = null; // Hata durumunda da null yap
      }
    }
  }

  // ─── SQLite şema ──────────────────────────────────────────────────────────

  _initDB() {
    this._db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
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
    `);

    // Prepared statements
    this._stmts = {
      upsertNode: this._db.prepare(`
        INSERT INTO nodes (id, workspace_id, label, weight, created, created_at, last_accessed, last_seen, vector, provenance)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, id) DO UPDATE SET
          workspace_id = excluded.workspace_id,
          label = excluded.label,
          weight = MIN(1.0, weight + 0.1),
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
      pruneEdges: this._db.prepare('DELETE FROM edges WHERE weight < ?'),
      countNodes: this._db.prepare('SELECT COUNT(*) as c FROM nodes'),
      countEdges: this._db.prepare('SELECT COUNT(*) as c FROM edges'),
      allNodes: this._db.prepare('SELECT * FROM nodes'),
      allEdges: this._db.prepare('SELECT * FROM edges'),
      updateEdgeWeight: this._db.prepare('UPDATE edges SET weight = ?, confidence = ?, source = ?, source_ref = ?, session_id = ?, evidence = ?, evidence_type = ?, confidence_history = ?, company_mode = ?, source_type = ?, updated_at = ?, provenance = ?, meta = ?, workspace_id = ? WHERE workspace_id = ? AND from_id = ? AND to_id = ? AND relation = ?'),
      updateNodeVector: this._db.prepare('UPDATE nodes SET vector = ? WHERE id = ? AND workspace_id = ?'),
      insertAuditEvent: this._db.prepare(`
        INSERT OR IGNORE INTO audit_log (
          audit_id, event_type, target_type, target_id, workspace_id, actor, timestamp,
          source_ref, provenance_id, trust_policy_version, details
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      allAuditEvents: this._db.prepare('SELECT * FROM audit_log ORDER BY timestamp ASC, audit_id ASC'),
    };
  }

  // ─── Node işlemleri ───────────────────────────────────────────────────────

  getNodes(workspaceId = 'default') {
    const scope = normalizeWorkspaceId(workspaceId);
    const nodes = {};
    for (const [id, node] of Object.entries(this._nodes)) {
      if (normalizeWorkspaceId(node.workspaceId) === scope) {
        nodes[id] = cloneNodeRecord(node);
      }
    }
    return nodes;
  }

  addNode(id, label, provenance = null, opts = {}) {
    const now = Date.now();
    const isoNow = nowIso();
    const hasExplicitProvenance = provenance && typeof provenance === 'object';
    const workspaceId = normalizeWorkspaceId(opts.workspaceId || provenance?.workspaceId);
    const storageKey = nodeStorageKey(id, workspaceId);
    if (this._db && this._stmts) {
      // SQLite path
      const existing = this._stmts.getNode.get(id, workspaceId);
      const vector = existing ? existing.vector : '{}';
      const createdAt = existing && existing.created_at ? existing.created_at : isoNow;
      const existingProvenance = JSON.parse((existing && existing.provenance) || 'null');
      const nextProvenance = hasExplicitProvenance ? provenance : existingProvenance;
      this._stmts.upsertNode.run(id, workspaceId, label, 0.5, now, createdAt, now, isoNow, vector, JSON.stringify(nextProvenance ?? null));
      // In-memory sync
      if (this._nodes[storageKey] && normalizeWorkspaceId(this._nodes[storageKey].workspaceId) === workspaceId) {
        this._nodes[storageKey].label = label;
        this._nodes[storageKey].workspaceId = workspaceId;
        this._nodes[storageKey].weight = Math.min(1, this._nodes[storageKey].weight + 0.1);
        this._nodes[storageKey].lastAccessed = now;
        this._nodes[storageKey].lastSeen = isoNow;
        this._nodes[storageKey].last_seen = isoNow;
        if (hasExplicitProvenance) this._nodes[storageKey].provenance = deepClone(provenance);
      } else {
        this._nodes[storageKey] = {
          id, label, tags: [], vector: {}, weight: 0.5, workspaceId,
          created: now, created_at: createdAt, lastAccessed: now,
          lastSeen: isoNow, last_seen: isoNow,
          provenance: nextProvenance ?? null,
        };
      }
    } else {
      if (this._nodes[storageKey] && normalizeWorkspaceId(this._nodes[storageKey].workspaceId) === workspaceId) {
        this._nodes[storageKey].label = label;
        this._nodes[storageKey].workspaceId = workspaceId;
        this._nodes[storageKey].weight = Math.min(1, this._nodes[storageKey].weight + 0.1);
        this._nodes[storageKey].lastAccessed = now;
        this._nodes[storageKey].lastSeen = isoNow;
        this._nodes[storageKey].last_seen = isoNow;
        if (hasExplicitProvenance) this._nodes[storageKey].provenance = deepClone(provenance);
      } else {
        this._nodes[storageKey] = {
          id, label, tags: [], vector: {}, weight: 0.5, workspaceId,
          created: now, created_at: isoNow, lastAccessed: now,
          lastSeen: isoNow, last_seen: isoNow,
          provenance: hasExplicitProvenance ? provenance : null,
        };
      }
    }
    return cloneNodeRecord(this._nodes[storageKey]);
  }

  getNode(id, workspaceId = 'default') {
    const scope = normalizeWorkspaceId(workspaceId);
    const storageKey = nodeStorageKey(id, scope);
    const node = this._nodes[storageKey] || (scope === 'default' ? this._nodes[id] : null);
    if (!node || normalizeWorkspaceId(node.workspaceId) !== scope) return null;
    node.lastAccessed = Date.now();
    if (this._db && this._stmts) {
      this._stmts.touchNode.run(Date.now(), id, scope);
    }
    return cloneNodeRecord(node);
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

  getAuditEvents(filters = {}) {
    let events = this._auditEvents;
    if (this._db && this._stmts) {
      const dbEvents = this._stmts.allAuditEvents.all().map((row) => normalizeAuditEvent({
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
      const merged = new Map();
      for (const event of [...dbEvents, ...this._auditEvents]) {
        merged.set(event.auditId, cloneAuditEvent(event));
      }
      events = Array.from(merged.values()).sort((a, b) => {
        const timestampDiff = String(a.timestamp || '').localeCompare(String(b.timestamp || ''));
        if (timestampDiff !== 0) return timestampDiff;
        return String(a.auditId || '').localeCompare(String(b.auditId || ''));
      });
    }
    return filterAuditEvents(events, filters);
  }

  addCandidateClaim(candidate, opts = {}) {
    const normalized = normalizeCandidateClaim({
      ...candidate,
      workspaceId: opts.workspaceId || candidate?.workspaceId || candidate?.provenance?.workspaceId || candidate?.proposedEdge?.workspaceId,
    });
    const workspaceId = normalizeWorkspaceId(normalized.workspaceId);
    const index = this._candidateClaims.findIndex(item =>
      item.candidateId === normalized.candidateId &&
      normalizeWorkspaceId(item.workspaceId) === workspaceId
    );

    if (index >= 0) {
      this._candidateClaims[index] = {
        ...this._candidateClaims[index],
        ...normalized,
        workspaceId,
        candidateId: normalized.candidateId,
      };
    } else {
      this._candidateClaims.push({
        ...normalized,
        workspaceId,
        candidateId: normalized.candidateId,
      });
    }

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

    return this.getCandidateClaims({ workspaceId }).find(item => item.candidateId === normalized.candidateId) || normalized;
  }

  getCandidateClaims(filters = {}) {
    const normalizedFilters = { ...filters };
    if (Object.prototype.hasOwnProperty.call(filters, 'workspaceId')) {
      if (filters.workspaceId === undefined || filters.workspaceId === null) {
        normalizedFilters.workspaceId = undefined;
      } else if (typeof filters.workspaceId === 'string' && !filters.workspaceId.trim()) {
        normalizedFilters.workspaceId = null;
      } else {
        normalizedFilters.workspaceId = normalizeWorkspaceId(filters.workspaceId);
      }
    } else {
      normalizedFilters.workspaceId = undefined;
    }
    return this._candidateClaims.filter((candidate) => {
      if (normalizedFilters.workspaceId === null) return false;
      if (normalizedFilters.workspaceId !== undefined && normalizeWorkspaceId(candidate.workspaceId) !== normalizeWorkspaceId(normalizedFilters.workspaceId)) return false;
      if (normalizedFilters.status && candidate.status !== normalizedFilters.status) return false;
      if (normalizedFilters.recommendation && candidate.recommendation !== normalizedFilters.recommendation) return false;
      if (normalizedFilters.candidateId && candidate.candidateId !== normalizedFilters.candidateId) return false;
      if (normalizedFilters.reviewedBy && candidate.reviewedBy !== normalizedFilters.reviewedBy) return false;
      if (normalizedFilters.provenanceId && candidate.provenance?.provenanceId !== normalizedFilters.provenanceId) return false;
      if (normalizedFilters.sourceRef && candidate.provenance?.sourceRef !== normalizedFilters.sourceRef) return false;
      return true;
    });
  }

  removeNode(id, workspaceId = 'default') {
    const node = this.getNode(id, workspaceId);
    if (!node) return false;
    const storageKey = nodeStorageKey(id, workspaceId);
    delete this._nodes[storageKey];
    this._edges = this._edges.filter(e => !(e.workspaceId === node.workspaceId && (e.from === id || e.to === id)));
    this._rebuildIndex();
    if (this._db && this._stmts) {
      this._stmts.deleteEdgesOf.run(id, id, normalizeWorkspaceId(workspaceId));
      this._stmts.deleteNode.run(id, normalizeWorkspaceId(workspaceId));
    }
    return true;
  }

  getWeight(id, workspaceId = 'default') {
    const node = this.getNode(id, workspaceId);
    if (!node) return 0;
    const elapsed = (Date.now() - node.lastAccessed) / 1000;
    const decayed = node.weight * Math.exp(-this._decayLambda * elapsed);
    return Math.max(0, Math.min(1, decayed));
  }

  addTag(nodeId, dim, weight, workspaceId = 'default') {
    const storageKey = nodeStorageKey(nodeId, workspaceId);
    const node = this._nodes[storageKey] || (normalizeWorkspaceId(workspaceId) === 'default' ? this._nodes[nodeId] : null);
    if (!node) return;
    const v = node.vector;
    v[dim] = (v[dim] || 0) + weight;
    // SQLite'a vector güncelle (lazy — save() sırasında toplu yazılır)
  }

  // ─── Edge işlemleri ───────────────────────────────────────────────────────

  addEdge(fromId, toId, relation, opts = {}) {
    const workspaceId = normalizeWorkspaceId(opts.workspaceId || opts.provenance?.workspaceId);
    if (!this.getNode(fromId, workspaceId) || !this.getNode(toId, workspaceId)) return null;
    const hasExplicitProvenance = opts.provenance && typeof opts.provenance === 'object';
    const hasExplicitMeta = isPlainObject(opts.meta);
    const nextMeta = sanitizeEdgeMeta(opts.meta);
    
    // Causal relation validation for v0.7
    const isCausal = CAUSAL_RELATIONS.includes(relation);
    if (isCausal) {
      // Causal relations require strength field
      if (opts.strength === undefined) {
        throw new Error(`Causal relation '${relation}' requires strength field (0-1)`);
      }
      if (typeof opts.strength !== 'number' || opts.strength < 0 || opts.strength > 1) {
        throw new Error(`Causal relation '${relation}' requires strength between 0 and 1`);
      }
    }
    
      const existing = (this._outIndex.get(edgeIndexKey(fromId, workspaceId)) || []).find(
        e => e.to === toId && e.relation === relation && normalizeWorkspaceId(e.workspaceId) === workspaceId
      );
      const isoNow = nowIso();
      const requestedCreatedAt = typeof opts.createdAt === 'string' && opts.createdAt ? opts.createdAt : '';
      const nextEvidence = Array.isArray(opts.evidence) ? opts.evidence : [];
      if (existing) {
        const oldConfidence = existing.confidence ?? existing.weight ?? 0.5;
        const requestedWeight = opts.weight === undefined
          ? (existing.weight ?? 0.5) + 0.1
          : opts.weight;
        const nextWeight = clamp01(requestedWeight, existing.weight ?? 0.5);
        const requestedConfidence = opts.confidence === undefined
          ? (Number.isFinite(Number(existing.confidence)) ? existing.confidence : nextWeight)
          : opts.confidence;
        existing.weight = nextWeight;
        existing.confidence = clamp01(requestedConfidence, nextWeight);
        if (opts.source) existing.source = opts.source;
      if (typeof opts.sourceRef === 'string') existing.source_ref = opts.sourceRef;
      if (typeof opts.sessionId === 'string') existing.session_id = opts.sessionId;
      if (typeof opts.evidenceType === 'string') existing.evidence_type = opts.evidenceType;
      if (typeof opts.sourceType === 'string') existing.source_type = opts.sourceType;
      if (typeof opts.companyMode === 'boolean') existing.company_mode = opts.companyMode ? 1 : 0;
      if (hasExplicitProvenance) existing.provenance = deepClone(opts.provenance);
      if (hasExplicitMeta) existing.meta = nextMeta;
      else existing.meta = sanitizeEdgeMeta(existing.meta);
      existing.workspaceId = workspaceId;
      if (requestedCreatedAt && !existing.created_at) existing.created_at = requestedCreatedAt;
      existing.evidence = [...new Set([...(existing.evidence || []), ...nextEvidence])];
      existing.updated_at = isoNow;
      if (isCausal && opts.strength !== undefined) existing.strength = opts.strength;
      if (!Array.isArray(existing.confidence_history)) existing.confidence_history = [];
      if (existing.confidence !== oldConfidence) {
        existing.confidence_history.push({ value: oldConfidence, updated_at: isoNow });
      }
      if (this._db && this._stmts) {
        this._stmts.updateEdgeWeight.run(
          existing.weight,
          existing.confidence,
          existing.source || 'manual',
          existing.source_ref || '',
          existing.session_id || '',
          JSON.stringify(existing.evidence || []),
          existing.evidence_type || '',
          JSON.stringify(existing.confidence_history || []),
          existing.company_mode ? 1 : 0,
          existing.source_type || '',
          existing.updated_at || isoNow,
          JSON.stringify(existing.provenance ?? null),
          JSON.stringify(existing.meta ?? {}),
          workspaceId,
          workspaceId,
          fromId,
          toId,
          relation
        );
      }
      return cloneEdgeRecord(existing);
    }
      const edge = {
        from: fromId,
        to: toId,
        relation,
        weight: clamp01(opts.weight, 0.5),
        confidence: clamp01(opts.confidence, clamp01(opts.weight, 0.5)),
        source: opts.source || 'manual',
        source_ref: opts.sourceRef || '',
        session_id: opts.sessionId || '',
      evidence: nextEvidence,
      evidence_type: opts.evidenceType || '',
      confidence_history: [],
      company_mode: opts.companyMode ? 1 : 0,
        source_type: opts.sourceType || '',
        updated_at: isoNow,
        created_at: requestedCreatedAt || isoNow,
        provenance: hasExplicitProvenance ? deepClone(opts.provenance) : null,
        meta: nextMeta,
        created: Date.now(),
        workspaceId,
      };
    if (isCausal) {
      edge.strength = opts.strength ?? 0.5;
    }
    this._edges.push(edge);
    this._indexEdge(edge);
    if (this._db && this._stmts) {
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
        edge.strength ?? 0.5
      );
    }
    return cloneEdgeRecord(edge);
  }

  getEdge(fromId, toId, relation, workspaceId = 'default') {
    const out = this._outIndex.get(edgeIndexKey(fromId, workspaceId)) || [];
    for (const e of out) {
      if (e.to === toId && e.relation === relation && normalizeWorkspaceId(e.workspaceId) === normalizeWorkspaceId(workspaceId)) return cloneEdgeRecord(e);
    }
    return null;
  }

  getEdgesBetween(fromId, toId, workspaceId = 'default') {
    const out = this._outIndex.get(edgeIndexKey(fromId, workspaceId)) || [];
    return out.filter(e => e.to === toId && normalizeWorkspaceId(e.workspaceId) === normalizeWorkspaceId(workspaceId)).map(cloneEdgeRecord);
  }

  hasAnyEdge(fromId, toId, workspaceId = 'default') {
    return this.getEdgesBetween(fromId, toId, workspaceId).length > 0;
  }

  getEdges(nodeId, workspaceId = 'default') {
    const out = this._outIndex.get(edgeIndexKey(nodeId, workspaceId)) || [];
    return out.filter(e => normalizeWorkspaceId(e.workspaceId) === normalizeWorkspaceId(workspaceId)).map(cloneEdgeRecord);
  }

  getInEdges(nodeId, workspaceId = 'default') {
    const out = this._inIndex.get(edgeIndexKey(nodeId, workspaceId)) || [];
    return out.filter(e => normalizeWorkspaceId(e.workspaceId) === normalizeWorkspaceId(workspaceId)).map(cloneEdgeRecord);
  }

  query(label, workspaceId = 'default') {
    return Object.values(this._nodes)
      .filter(n => n.label === label && normalizeWorkspaceId(n.workspaceId) === normalizeWorkspaceId(workspaceId))
      .map(cloneNodeRecord);
  }

  nodeCount(workspaceId) {
    if (!workspaceId) return Object.keys(this._nodes).length;
    return Object.values(this._nodes).filter(n => normalizeWorkspaceId(n.workspaceId) === normalizeWorkspaceId(workspaceId)).length;
  }
  edgeCount(workspaceId) {
    if (!workspaceId) return this._edges.length;
    return this._edges.filter(e => normalizeWorkspaceId(e.workspaceId) === normalizeWorkspaceId(workspaceId)).length;
  }

  cosineSimilarity(aId, bId, workspaceId = 'default') {
    const a = this.getNode(aId, workspaceId);
    const b = this.getNode(bId, workspaceId);
    if (!a || !b) return 0;
    const dims = new Set([...Object.keys(a.vector), ...Object.keys(b.vector)]);
    let dot = 0, magA = 0, magB = 0;
    for (const d of dims) {
      const va = a.vector[d] || 0;
      const vb = b.vector[d] || 0;
      dot += va * vb; magA += va * va; magB += vb * vb;
    }
    const mag = Math.sqrt(magA) * Math.sqrt(magB);
    return mag === 0 ? 0 : dot / mag;
  }

  prune(threshold) {
    if (threshold === undefined) threshold = this._pruneThreshold;
    const before = this._edges.length;
    this._edges = this._edges.filter(e => e.weight >= threshold);
    this._rebuildIndex();
    const pruned = before - this._edges.length;
    if (this._db && pruned > 0) {
      this._stmts.pruneEdges.run(threshold);
    }
    return pruned;
  }

  optimize() {
    const now = Date.now();
    let pruned = this.prune();
    const nodeIds = Object.keys(this._nodes);
    let removedNodes = 0;
    for (const id of nodeIds) {
      const node = this._nodes[id];
      const elapsed = (now - node.lastAccessed) / 1000;
      const decayed = node.weight * Math.exp(-this._decayLambda * elapsed);
      const outEdges = this.getEdges(node.id, node.workspaceId);
      const inEdges = this.getInEdges(node.id, node.workspaceId);
      if (decayed < 0.01 && outEdges.length === 0 && inEdges.length === 0) {
        delete this._nodes[id];
        if (this._db && this._stmts) this._stmts.deleteNode.run(node.id, normalizeWorkspaceId(node.workspaceId));
        removedNodes++;
      }
    }
    return { pruned, removedNodes };
  }

  getStats() {
    return {
      nodes: this.nodeCount(),
      edges: this.edgeCount(),
      candidateClaims: this._candidateClaims.length,
      decayLambda: this._decayLambda,
      backend: this._db ? 'sqlite' : 'json',
    };
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
    this.prune();
    const embeddings = this._stripEmbeddings();

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
        this._db.prepare(`
          INSERT INTO edges (workspace_id, from_id, to_id, relation, weight, confidence, source, source_ref, session_id, evidence, evidence_type, confidence_history, company_mode, source_type, updated_at, created_at, provenance, meta, created)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
              meta = excluded.meta
          `).run(
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
            edge.created
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

    // JSON de yaz (Rust katmanı ve fallback için)
    const data = {
      nodes: this._nodes,
      edges: this._edges,
      candidateClaims: this._candidateClaims,
      auditEvents: this._auditEvents,
    };
    fs.writeFileSync(this.memoryPath, JSON.stringify(data), 'utf8');

    // Embedding'leri geri koy
    this._restoreEmbeddings(embeddings);

    // Embedding'leri ayrı dosyaya yaz
    if (Object.keys(embeddings).length > 0) {
      fs.writeFileSync(this._embeddingPath, JSON.stringify(embeddings), 'utf8');
    }
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
            try {
              const emb = JSON.parse(fs.readFileSync(this._embeddingPath, 'utf-8'));
              this._restoreEmbeddings(emb);
            } catch (_) {}
          }
          return; // SQLite'tan başarıyla yüklendi
        }
      } catch (e) {
        console.error('[Graph] SQLite yükleme hatası, JSON fallback:', e.message);
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
    return CAUSAL_RELATIONS.includes(relation);
  }

  getCausalRelations() {
    return [...CAUSAL_RELATIONS];
  }

  getCausalEdges(fromId, workspaceId = 'default') {
    const edges = this.getEdges(fromId, workspaceId);
    return edges
      .filter(e => this.isCausalRelation(e.relation))
      .slice()
      .sort(compareCausalEdges);
  }

  getCausalChain(fromId, maxDepthOrOpts = 10) {
    const opts = typeof maxDepthOrOpts === 'object' && maxDepthOrOpts !== null
      ? maxDepthOrOpts
      : { maxDepth: maxDepthOrOpts };
    const maxDepth = Number.isFinite(opts.maxDepth) ? Math.max(0, opts.maxDepth) : 10;
    const workspaceId = normalizeWorkspaceId(opts.workspaceId);

    const chain = [];
    const visited = [];
    const visitedSet = new Set();
    const loops = [];
    const queue = [{ node: fromId, depth: 0, path: [], pathNodes: [fromId] }];
    let stoppedReason = this.getNode(fromId, workspaceId) ? 'exhausted' : 'missing-start-node';
    let confidenceTotal = 0;
    let confidenceCount = 0;
    let depthStopped = false;

    if (!this.getNode(fromId, workspaceId)) {
      return attachTraversalMeta(chain, {
        start: fromId,
        visited,
        loops,
        stoppedReason,
        maxDepth,
        confidence: 0,
      });
    }

    while (queue.length > 0) {
      const { node, depth, path, pathNodes } = queue.shift();
      if (depth >= maxDepth) {
        depthStopped = true;
        continue;
      }
      if (!visitedSet.has(node)) {
        visitedSet.add(node);
        visited.push(node);
      }

      const causalEdges = this.getCausalEdges(node, workspaceId);
      for (const edge of causalEdges) {
        const step = normalizeCausalStep(edge);
        const newPath = [...path, step];
        chain.push(newPath);
        confidenceTotal += step.confidence ?? 0;
        confidenceCount += 1;

        if (pathNodes.includes(edge.to)) {
          loops.push([...pathNodes, edge.to]);
          continue;
        }

        queue.push({
          node: edge.to,
          depth: depth + 1,
          path: newPath,
          pathNodes: [...pathNodes, edge.to],
        });
      }
    }

    if (depthStopped) {
      stoppedReason = 'maxDepth';
    }

    return attachTraversalMeta(chain, {
      start: fromId,
      visited,
      loops,
      stoppedReason,
      maxDepth,
      confidence: confidenceCount > 0 ? confidenceTotal / confidenceCount : 0,
    });
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
