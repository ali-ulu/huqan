const {
  CAUSAL_RELATIONS,
  STANDARD_RELATIONS,
  normalizeWorkspaceId,
  edgeIndexKey,
  compareCausalEdges,
} = require('./lib/graph-record-utils');
const { derivePersistenceLayout, resolveDefaultMemoryPath } = require('./lib/memory-store-utils');
const { appendReceiptToChain } = require('./lib/receipt/receipt-chain');
const { assertDurableV4WriteAllowed, classifyReceiptFamily } = require('./lib/receipt/v4-receipt-family');
const { countAuditEvents, queryAuditEvents, readAuditEvents } = require('./lib/audit-query');
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
const consolidateEdges = require('./lib/graph-consolidate-edges');
const {
  jsonJournalPath: runJsonJournalPath,
  emptyJsonJournal: runEmptyJsonJournal,
  readJsonJournal: runReadJsonJournal,
  writeJsonJournal: runWriteJsonJournal,
  readMutationReceiptFromJsonJournal: runReadMutationReceiptFromJsonJournal,
  readMutationReceipt: runReadMutationReceipt,
  mutationReceiptReadStoreApi: runMutationReceiptReadStoreApi,
  getCommittedMutationResultByOperation: runCommittedMutationResult,
  getCommittedMutationResultsByPrefix: runCommittedMutationResultsByPrefix,
  runMutationOnce,
  runMutationOnceSqlite,
  runMutationOnceJson,
  runMutationOnceJsonLocked,
} = require('./lib/graph-mutation-runtime');
const {
  nodeWriteStoreApi: runNodeWriteStoreApi,
  nodeTouchStoreApi: runNodeTouchStoreApi,
  appendAuditEvent: runAppendAuditEvent,
  auditQueryContext: runAuditQueryContext,
  candidateClaimWriteStoreApi: runCandidateClaimWriteStoreApi,
  nodeDeleteStoreApi: runNodeDeleteStoreApi,
  nodeTagStoreApi: runNodeTagStoreApi,
  edgeWriteStoreApi: runEdgeWriteStoreApi,
  pruneStoreApi: runPruneStoreApi,
  optimizeStoreApi: runOptimizeStoreApi,
  statsStoreApi: runStatsStoreApi,
  createGraphStorePort,
} = require('./lib/graph-store-adapters');
const { isSqliteAvailable, openGraphSqlite: runOpenSqlite, closeGraphSqlite: runCloseSqlite, reopenGraphSqlite: runReopenSqlite, sqlitePersistenceError } = require('./lib/sqlite-persistence-validation');
const { initGraphSchema, createGraphStmts } = require('./lib/graph-sqlite-schema');
const { ensureMutationReceiptFamilySchema: runMutationReceiptFamilySchema } = require('./lib/graph-mutation-receipt-schema');
const { getCommittedMutationReceiptByOperation: runReceiptByOperationRead, getCommittedMutationReceiptById: runReceiptByIdRead } = require('./lib/graph-mutation-receipt-read');

const mutationReceiptDeps = { appendReceiptToChain, assertDurableV4WriteAllowed, classifyReceiptFamily };

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
    const wantSQLite = opts.useSQLite !== false && isSqliteAvailable();
    this._wantSqlite = wantSQLite;
    // Retained so reopen() can rebuild the handle against the same options
    // (busy timeout, migration flags) after restore replaced the DB file.
    this._sqliteOptions = opts;
    this._db = null;
    this._stmts = null; // SQLite statement güvenliği için null init
    this._storePort = createGraphStorePort(this, sqlitePersistenceError);
    if (wantSQLite) {
      this._openSqlite(opts);
    }
  }

  _openSqlite(opts) { return runOpenSqlite(this, opts, nextOpts => this._initDB(nextOpts)); }
  closeSqlite() { return runCloseSqlite(this); }
  reopen(opts = this._sqliteOptions) { return runReopenSqlite(this, opts, nextOpts => this._initDB(nextOpts)); }
  _initDB(opts = {}) { initGraphSchema(this._db, opts); this._stmts = createGraphStmts(this._db); }

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
    return runReceiptByOperationRead(this._mutationReceiptReadStoreApi(), operationId);
  }
  getCommittedMutationReceiptById(receiptId) {
    return runReceiptByIdRead(this._mutationReceiptReadStoreApi(), receiptId);
  }
  _mutationReceiptReadStoreApi() { return runMutationReceiptReadStoreApi(this); }
  getCommittedMutationResultByOperation(operationId) { return runCommittedMutationResult(this, operationId); }
  getCommittedMutationResultsByPrefix(prefix) { return runCommittedMutationResultsByPrefix(this, prefix); }
  runMutationOnce(operationId, mutate, opts = {}) { return runMutationOnce(this, operationId, mutate, opts, mutationReceiptDeps); }
  _runMutationOnceSqlite(id, mutate, opts) { return runMutationOnceSqlite(this, id, mutate, opts, mutationReceiptDeps); }
  _runMutationOnceJson(id, mutate, opts) { return runMutationOnceJson(this, id, mutate, opts, mutationReceiptDeps); }
  _runMutationOnceJsonLocked(id, mutate, opts) { return runMutationOnceJsonLocked(this, id, mutate, opts, mutationReceiptDeps); }

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

  _nodeWriteStoreApi() { return runNodeWriteStoreApi(this); }

  addNode(id, label, provenance = null, opts = {}) {
    return runNodeWrite(this._nodeWriteStoreApi(), id, label, provenance, opts);
  }

  getNode(id, workspaceId = 'default') {
    return runNodeRead(this._nodes, id, workspaceId);
  }

  _nodeTouchStoreApi() { return runNodeTouchStoreApi(this); }

  touchNode(id, workspaceId = 'default') {
    return runNodeTouch(this._nodeTouchStoreApi(), id, workspaceId);
  }

  appendAuditEvent(event, opts = {}) { return runAppendAuditEvent(this, event, opts); }

  _auditQueryContext() { return runAuditQueryContext(this); }

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

  _candidateClaimWriteStoreApi() { return runCandidateClaimWriteStoreApi(this); }

  addCandidateClaim(candidate, opts = {}) {
    return runCandidateClaimWrite(this._candidateClaimWriteStoreApi(), candidate, opts);
  }

  getCandidateClaims(filters = {}) {
    return runCandidateClaimsRead(this._candidateClaims, filters);
  }

  _nodeDeleteStoreApi() { return runNodeDeleteStoreApi(this); }

  removeNode(id, workspaceId = 'default') {
    return runNodeDelete(this._nodeDeleteStoreApi(), id, workspaceId);
  }

  getWeight(id, workspaceId = 'default') {
    return runNodeWeight((nodeId, scope) => this.getNode(nodeId, scope), this._decayLambda, id, workspaceId);
  }

  _nodeTagStoreApi() { return runNodeTagStoreApi(this); }

  addTag(nodeId, dim, weight, workspaceId = 'default') {
    return runNodeTag(this._nodeTagStoreApi(), nodeId, dim, weight, workspaceId);
  }

  // ─── Edge işlemleri ───────────────────────────────────────────────────────

  _edgeWriteStoreApi() { return runEdgeWriteStoreApi(this, { indexEdge: edge => this._indexEdge(edge), recordEdgeTouch: (...args) => this._recordEdgeTouch(...args) }); }

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

  _pruneStoreApi() { return runPruneStoreApi(this); }

  prune(threshold, workspaceId = 'default') {
    return runGraphPrune(this._pruneStoreApi(), threshold, workspaceId);
  }

  _optimizeStoreApi() { return runOptimizeStoreApi(this); }

  optimize(workspaceId = 'default') {
    return runGraphOptimize(this._optimizeStoreApi(), workspaceId);
  }

  _statsStoreApi() { return runStatsStoreApi(this); }

  getStats() {
    return runGraphStats(this._statsStoreApi());
  }

  // ─── Kalıcılık ────────────────────────────────────────────────────────────

  stripEmbeddings() {
    return this._storePort.stripEmbeddings();
  }

  restoreEmbeddings(embeddings) {
    return this._storePort.restoreEmbeddings(embeddings);
  }

  save() {
    return this._storePort.save(this._jsonTransactionFault);
  }

  writeStrippedState(embeddings) {
    return this._storePort.writeStrippedState(embeddings);
  }

  load() {
    return this._storePort.load();
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
