const {
  CAUSAL_RELATIONS,
  STANDARD_RELATIONS,
  normalizeWorkspaceId,
  edgeIndexKey,
} = require('./lib/graph-record-utils');
const { derivePersistenceLayout, resolveDefaultMemoryPath } = require('./lib/memory-store-utils');
const consolidateEdges = require('./lib/graph-consolidate-edges');
const {
  appendAuditEvent: runAppendAuditEvent,
  auditQueryContext: runAuditQueryContext,
  createGraphStorePort,
} = require('./lib/graph-store-adapters');
const { isSqliteAvailable, openGraphSqlite: runOpenSqlite, closeGraphSqlite: runCloseSqlite, reopenGraphSqlite: runReopenSqlite, sqlitePersistenceError } = require('./lib/sqlite-persistence-validation');
const { initGraphSchema, createGraphStmts } = require('./lib/graph-sqlite-schema');
const { createLabelIndex, indexNode: indexLabelNode, deindexNode: deindexLabelNode, rebuildLabelIndex, workspaceKeys } = require('./lib/graph-label-index');
const { appendReceiptToChain } = require('./lib/receipt/receipt-chain');
const { assertDurableV4WriteAllowed, classifyReceiptFamily } = require('./lib/receipt/v4-receipt-family');
// Method groups that moved out of this file (#3101). Each is installed with
// the descriptor it had as a class member; see lib/graph-method-install.js.
const { install: installJournalMethods } = require('./lib/graph-journal-methods');
const { install: installReadMethods } = require('./lib/graph-read-methods');
const { install: installWriteMethods } = require('./lib/graph-write-methods');

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
    this._labelIndex = createLabelIndex();
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

  consolidateEdges(dryRun = true) {
    return consolidateEdges({ edges: this._edges, dryRun, replaceEdges: arr => { this._edges = arr; }, rebuildIndex: () => this.rebuildIndex(), save: () => this.save(), logSaveError: error => { console.error('[Kernel] Graph save hatası:', error.message); }, auditRemoval: (edge, reason) => this.appendAuditEvent({ eventType: 'DELETE', targetType: 'edge', targetId: `${edge.from}|${edge.relation}|${edge.to}`, workspaceId: normalizeWorkspaceId(edge.workspaceId), actor: 'graph.consolidate', sourceRef: 'graph.consolidate', details: { reason, weight: edge.weight } }) });
  }

  appendAuditEvent(event, opts = {}) { return runAppendAuditEvent(this, event, opts); }

  _auditQueryContext() { return runAuditQueryContext(this); }

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

  // #3009: label index maintenance. Both write paths call these through the
  // node store API; rebuildIndex() reconstructs the whole index from `_nodes`,
  // so load/restore/rollback/consolidate stay correct without patching.
  // Lazily created so instances built via Object.create(Graph.prototype) in
  // tests keep working without carrying the constructor's initialization.
  _labelIndexOrCreate() {
    if (!this._labelIndex) this._labelIndex = createLabelIndex();
    return this._labelIndex;
  }

  _indexLabelNode(storageKey, node) {
    indexLabelNode(this._labelIndexOrCreate(), storageKey, node);
  }

  _deindexLabelNode(storageKey) {
    deindexLabelNode(this._labelIndexOrCreate(), storageKey);
  }

  // Storage keys of every node in a workspace, from the index (#3009).
  _workspaceNodeKeys(workspaceId = 'default') {
    return workspaceKeys(this._labelIndexOrCreate(), workspaceId);
  }

  rebuildIndex() {
    this._rebuildEdgeIndex();
    rebuildLabelIndex(this._labelIndexOrCreate(), this._nodes);
  }

  // #3009: prune() and removeNode() only ever change `_edges`; the node label
  // index is maintained incrementally on those paths. Rebuilding the whole
  // label index (an O(N) scan of `_nodes`) there was the "rebuild on every
  // deletion" cost the issue calls out, so the edge-only rebuild is split out.
  // Load, restore, rollback and consolidate still call rebuildIndex() because
  // they can replace `_nodes` wholesale.
  _rebuildEdgeIndex() {
    this._outIndex.clear();
    this._inIndex.clear();
    for (const e of this._edges) this._indexEdge(e);
  }

  // ─── Temizlik ─────────────────────────────────────────────────────────────

  close() {
    if (this._db && this._stmts) {
      try { this._db.close(); } catch (_) {}
      this._db = null;
    }
  }
}

installJournalMethods(Graph, mutationReceiptDeps);
installReadMethods(Graph);
installWriteMethods(Graph);

module.exports = Graph;
module.exports.Graph = Graph;
module.exports.CAUSAL_RELATIONS = CAUSAL_RELATIONS;
module.exports.STANDARD_RELATIONS = STANDARD_RELATIONS;
