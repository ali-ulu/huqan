const fs = require('fs');
const path = require('path');
const { buildAuditEvent } = require('./lib/audit-log');

// SQLite opsiyonel — yoksa JSON fallback
let Database;
try { Database = require('better-sqlite3'); } catch (_) { Database = null; }

const {
  CAUSAL_RELATIONS,
  STANDARD_RELATIONS,
  RECEIPT_FAMILY_MIGRATION_ERROR_CODE,
  normalizeWorkspaceId,
  nodeStorageKey,
  edgeIndexKey,
  nowIso,
  compareCausalEdges,
  edgeUpdateArgs,
} = require('./lib/graph-record-utils');
const { derivePersistenceLayout, resolveDefaultMemoryPath } = require('./lib/memory-store-utils');
const { assertGraphPersistenceWritable } = require('./lib/graph-json-persistence');
const { saveSnapshot, writeCurrentState } = require('./lib/graph-json-snapshot');
const { assertStoreOpenAllowed, handleSqliteInitializationError, hasExistingPersistenceFile } = require('./lib/sqlite-persistence-validation');
const { countAuditEvents, queryAuditEvents, readAuditEvents } = require('./lib/audit-query');
const { applyTemporalEdgeMetadata, beginEdgeTouchScope, downgradeEdge, edgeTouchKey } = require('./lib/graph-edge-mutations');
const { getCausalChain: runCausalChain } = require('./lib/graph-causal-chain');
const { getCandidateClaims: runCandidateClaimsRead } = require('./lib/graph-candidate-claims-read');
const { addCandidateClaim: runCandidateClaimWrite } = require('./lib/graph-candidate-claims-write');
const { initGraphSchema, createGraphStmts } = require('./lib/graph-sqlite-schema');
const {
  getEdge: runEdgeRead,
  getEdgesBetween: runEdgesBetweenRead,
  hasAnyEdge: runHasAnyEdgeRead,
  getEdges: runEdgesRead,
  getInEdges: runInEdgesRead,
  getAllEdges: runAllEdgesRead,
} = require('./lib/graph-edge-read');
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
const { prune: runGraphPrune } = require('./lib/graph-prune');
const { optimize: runGraphOptimize } = require('./lib/graph-optimize');
const { isCausalRelation: runIsCausalRelation, getCausalRelations: runCausalRelations, getCausalEdges: runCausalEdges } = require('./lib/graph-causal-relation-read');
const { addEdge: runEdgeWrite } = require('./lib/graph-edge-write');
const { ensureMutationReceiptFamilySchema: runMutationReceiptFamilySchema } = require('./lib/graph-mutation-receipt-schema');
const consolidateEdges = require('./lib/graph-consolidate-edges');
const {
  stripEmbeddings: runStripEmbeddings,
  restoreEmbeddings: runRestoreEmbeddings,
  writeStrippedState: runWriteStrippedState,
  load: runGraphPersistenceLoad,
} = require('./lib/graph-persistence-runtime');
const {
  jsonJournalPath: runJsonJournalPath,
  emptyJsonJournal: runEmptyJsonJournal,
  readJsonJournal: runReadJsonJournal,
  writeJsonJournal: runWriteJsonJournal,
  readMutationReceiptFromJsonJournal: runReadMutationReceiptFromJsonJournal,
  readMutationReceipt: runReadMutationReceipt,
  getCommittedMutationReceiptByOperation: runCommittedReceiptByOperation,
  getCommittedMutationReceiptById: runCommittedReceiptById,
  mutationReceiptReadStoreApi: runMutationReceiptReadStoreApi,
  getCommittedMutationResultByOperation: runCommittedMutationResult,
  getCommittedMutationResultsByPrefix: runCommittedMutationResultsByPrefix,
  runMutationOnce,
  runMutationOnceSqlite,
  runMutationOnceJson,
  runMutationOnceJsonLocked,
} = require('./lib/graph-mutation-runtime');

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
    this.memoryPath = opts.memoryPath || resolveDefaultMemoryPath();
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
    this._wantSqlite = wantSQLite;
    // Retained so reopen() can rebuild the handle against the same options
    // (busy timeout, migration flags) after restore replaced the DB file.
    this._sqliteOptions = opts;
    this._db = null;
    this._stmts = null; // SQLite statement güvenliği için null init
    if (wantSQLite) {
      this._openSqlite(opts);
    }
  }

  /**
   * Opens the SQLite handle and runs schema/migration/statement preparation.
   * Idempotent: safe to call again on a database file that restore just put in
   * place (CREATE ... IF NOT EXISTS + guarded ALTERs).
   */
  _openSqlite(opts) {
    const dbPath = this._paths.dbPath;
    const hasExistingDatabase = assertStoreOpenAllowed(dbPath, opts);
    try {
      this._db = new Database(dbPath);
      this._initDB(opts);
    } catch (e) {
      try { this._db?.close(); } catch (_) {}
      this._db = null;
      this._stmts = null;
      handleSqliteInitializationError(e, hasExistingDatabase, RECEIPT_FAMILY_MIGRATION_ERROR_CODE);
    }
  }

  /**
   * Closes the SQLite handle without touching in-memory state. Windows cannot
   * rename over an open database file (fs.renameSync -> EPERM; rename-over-open
   * is POSIX-only), and memory.db is exactly the file restore replaces. The CLI
   * closes the handle before the replacement and reopens it afterwards. See #1848.
   */
  closeSqlite() {
    if (this._db) {
      try { this._db.close(); } catch (_) {}
      this._db = null;
      this._stmts = null;
    }
  }

  /**
   * Closes any stale handle and reopens the SQLite database file. In-memory
   * data is left untouched and the caller still calls `load()` afterwards to
   * repopulate the graph from the file restore just wrote. No-op when this
   * graph does not use SQLite (JSON mode or better-sqlite3 unavailable).
   */
  reopen(opts = this._sqliteOptions) {
    this.closeSqlite();
    if (!this._wantSqlite || Database === null) return;
    this._openSqlite(opts || {});
  }

  // ─── SQLite şema ──────────────────────────────────────────────────────────

  _initDB(opts = {}) {
    initGraphSchema(this._db, opts);
    this._stmts = createGraphStmts(this._db);
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
   *
   * Public journal-path surface for the JSON backend (#2343, #2353).
   */
  jsonJournalPath() { return runJsonJournalPath(this); }
  _emptyJsonJournal() { return runEmptyJsonJournal(); }
  readJsonJournal() { return runReadJsonJournal(this); }
  _readJsonJournal() { return this.readJsonJournal(); }
  _writeJsonJournal(journal) { return runWriteJsonJournal(this, journal); }
  _readMutationReceiptFromJsonJournal(journal, operationId) {
    return runReadMutationReceiptFromJsonJournal(journal, operationId);
  }
  _readMutationReceipt(row) { return runReadMutationReceipt(row); }
  getCommittedMutationReceiptByOperation(operationId) {
    return runCommittedReceiptByOperation(this, operationId);
  }
  getCommittedMutationReceiptById(receiptId) {
    return runCommittedReceiptById(this, receiptId);
  }
  _mutationReceiptReadStoreApi() { return runMutationReceiptReadStoreApi(this); }
  getCommittedMutationResultByOperation(operationId) { return runCommittedMutationResult(this, operationId); }
  getCommittedMutationResultsByPrefix(prefix) { return runCommittedMutationResultsByPrefix(this, prefix); }
  runMutationOnce(operationId, mutate, opts = {}) { return runMutationOnce(this, operationId, mutate, opts); }
  _runMutationOnceSqlite(id, mutate, opts) { return runMutationOnceSqlite(this, id, mutate, opts); }
  _runMutationOnceJson(id, mutate, opts) { return runMutationOnceJson(this, id, mutate, opts); }
  _runMutationOnceJsonLocked(id, mutate, opts) { return runMutationOnceJsonLocked(this, id, mutate, opts); }

  // ─── Node işlemleri ───────────────────────────────────────────────────────

  assignEmbedding(storageKey, embedding) {
    this._mutationRollback?.recordNode(storageKey);
    this._nodes[storageKey].embedding = embedding;
  }

  /** Edge-touch scope + temporal stamping; see lib/graph-edge-mutations.js (#733). */
  captureTemporalEdgeKeys() {
    this._edgeTouchScope = beginEdgeTouchScope(this);
    return this._edgeTouchScope;
  }

  _recordEdgeTouch(workspaceId, from, relation, to) {
    if (this._edgeTouchScope) this._edgeTouchScope.touched.add(edgeTouchKey(workspaceId, from, relation, to));
  }

  applyTemporalEdgeMetadata(source, learnedAt, scope, opts = {}) {
    this._edgeTouchScope = null;
    return applyTemporalEdgeMetadata(this, { source, learnedAt, scope, workspaceId: opts.workspaceId });
  }

  /** Canonical downgrade/reclassify write path; see lib/graph-edge-mutations.js (#732). */
  downgradeEdge(spec = {}) {
    return downgradeEdge(this, spec);
  }

  consolidateEdges(dryRun = true) {
    return consolidateEdges({ edges: this._edges, dryRun, replaceEdges: arr => { this._edges = arr; }, rebuildIndex: () => this.rebuildIndex(), save: () => this.save(), logSaveError: error => { console.error('[Kernel] Graph save hatası:', error.message); }, auditRemoval: (edge, reason) => this.appendAuditEvent({ eventType: 'DELETE', targetType: 'edge', targetId: `${edge.from}|${edge.relation}|${edge.to}`, workspaceId: normalizeWorkspaceId(edge.workspaceId), actor: 'graph.consolidate', sourceRef: 'graph.consolidate', details: { reason, weight: edge.weight } }) });
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
      recordNode: storageKey => this._mutationRollback?.recordNode(storageKey),
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
    recordNode: storageKey => this._mutationRollback?.recordNode(storageKey),
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
      recordCandidateClaim: index => this._mutationRollback?.recordCandidateClaim(index),
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
    recordNode: storageKey => this._mutationRollback?.recordNode(storageKey),
    deleteNode: storageKey => delete this._nodes[storageKey],
    removeIncidentEdges: (id, workspaceId) => (this._edges = this._edges.filter(edge => !(edge.workspaceId === workspaceId && (edge.from === id || edge.to === id)))),
    rebuildIndex: () => this.rebuildIndex(),
    persistDeleteEdges: (id, workspaceId) => this._db && this._stmts && this._stmts.deleteEdgesOf.run(id, id, workspaceId),
    persistDeleteNode: (id, workspaceId) => this._db && this._stmts && this._stmts.deleteNode.run(id, workspaceId),
  }; }

  removeNode(id, workspaceId = 'default') {
    return runNodeDelete(this._nodeDeleteStoreApi(), id, workspaceId);
  }

  getWeight(id, workspaceId = 'default') {
    return runNodeWeight((nodeId, scope) => this.getNode(nodeId, scope), this._decayLambda, id, workspaceId);
  }

  _nodeTagStoreApi() { return {
    get: storageKey => this._nodes[storageKey],
    recordNode: storageKey => this._mutationRollback?.recordNode(storageKey),
  }; }

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
      recordEdge: edge => this._mutationRollback?.recordEdge(edge),
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

  _pruneStoreApi() { return { getEdges: () => this._edges, setEdges: edges => { this._edges = edges; }, rebuildIndex: () => this.rebuildIndex(), getPruneThreshold: () => this._pruneThreshold, persistPrune: (threshold, scope) => { if (this._db) this._stmts.pruneEdges.run(threshold, scope); } }; }

  prune(threshold, workspaceId = 'default') {
    return runGraphPrune(this._pruneStoreApi(), threshold, workspaceId);
  }

  _optimizeStoreApi() { return { prune: scope => this.prune(undefined, scope), getNodes: () => this._nodes, getEdges: (nodeId, scope) => this.getEdges(nodeId, scope), getInEdges: (nodeId, scope) => this.getInEdges(nodeId, scope), decayLambda: this._decayLambda, recordNode: id => this._mutationRollback?.recordNode(id), deleteNode: id => { this._mutationRollback?.recordNode(id); delete this._nodes[id]; }, persistDeleteNode: (id, scope) => { if (this._db && this._stmts) this._stmts.deleteNode.run(id, scope); }, auditRemoval: (node, decayedWeight) => this.appendAuditEvent({ eventType: 'DELETE', targetType: 'node', targetId: node.id, workspaceId: normalizeWorkspaceId(node.workspaceId), actor: 'graph.optimize', sourceRef: 'graph.optimize', details: { reason: 'decayed_isolated_node', decayedWeight } }) }; }

  optimize(workspaceId = 'default') {
    return runGraphOptimize(this._optimizeStoreApi(), workspaceId);
  }

  _statsStoreApi() { return { nodeCount: () => this.nodeCount(), edgeCount: () => this.edgeCount(), candidateClaims: this._candidateClaims, decayLambda: this._decayLambda, hasSqlite: Boolean(this._db) }; }

  getStats() {
    return runGraphStats(this._statsStoreApi());
  }

  // ─── Kalıcılık ────────────────────────────────────────────────────────────

  stripEmbeddings() {
    return runStripEmbeddings(this);
  }

  restoreEmbeddings(embeddings) {
    return runRestoreEmbeddings(this, embeddings);
  }

  save() {
    assertGraphPersistenceWritable(this);
    return this._db && this._stmts ? writeCurrentState(this) : saveSnapshot(this, () => writeCurrentState(this), this._jsonTransactionFault);
  }

  writeStrippedState(embeddings) {
    return runWriteStrippedState(this, embeddings);
  }

  load() {
    return runGraphPersistenceLoad(this);
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

  rebuildIndex() {
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
