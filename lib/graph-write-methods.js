'use strict';

// Graph's write methods, moved out of graph.js unchanged (#3101): node, edge,
// tag and candidate-claim writes, prune, optimize, and edge-touch/temporal
// stamping. Each goes through its store adapter as before; the audit append,
// the consolidate maintenance audit and the persistence wiring stay in
// graph.js. Installed on Graph.prototype by graph.js with the descriptors they
// had as class methods; `this` is the Graph instance.

const { applyTemporalEdgeMetadata, beginEdgeTouchScope, downgradeEdge, edgeTouchKey } = require('./graph-edge-mutations');
const { addCandidateClaim: runCandidateClaimWrite } = require('./graph-candidate-claims-write');
const { addNode: runNodeWrite } = require('./graph-node-write');
const { removeNode: runNodeDelete } = require('./graph-node-delete');
const { touchNode: runNodeTouch } = require('./graph-node-touch');
const { addTag: runNodeTag } = require('./graph-node-tag');
const { prune: runGraphPrune } = require('./graph-prune');
const { optimize: runGraphOptimize } = require('./graph-optimize');
const { addEdge: runEdgeWrite } = require('./graph-edge-write');
const {
  nodeWriteStoreApi: runNodeWriteStoreApi,
  nodeTouchStoreApi: runNodeTouchStoreApi,
  candidateClaimWriteStoreApi: runCandidateClaimWriteStoreApi,
  nodeDeleteStoreApi: runNodeDeleteStoreApi,
  nodeTagStoreApi: runNodeTagStoreApi,
  edgeWriteStoreApi: runEdgeWriteStoreApi,
  pruneStoreApi: runPruneStoreApi,
  optimizeStoreApi: runOptimizeStoreApi,
} = require('./graph-store-adapters');
const { installGraphMethods } = require('./graph-method-install');

class GraphWriteMethods {
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

  _nodeWriteStoreApi() { return runNodeWriteStoreApi(this, { reindex: storageKey => this._indexLabelNode(storageKey, this._nodes[storageKey]) }); }

  addNode(id, label, provenance = null, opts = {}) {
    return runNodeWrite(this._nodeWriteStoreApi(), id, label, provenance, opts);
  }

  _nodeTouchStoreApi() { return runNodeTouchStoreApi(this); }

  touchNode(id, workspaceId = 'default') {
    return runNodeTouch(this._nodeTouchStoreApi(), id, workspaceId);
  }

  _candidateClaimWriteStoreApi() { return runCandidateClaimWriteStoreApi(this); }

  addCandidateClaim(candidate, opts = {}) {
    return runCandidateClaimWrite(this._candidateClaimWriteStoreApi(), candidate, opts);
  }

  _nodeDeleteStoreApi() { return runNodeDeleteStoreApi(this, { deindex: storageKey => this._deindexLabelNode(storageKey), rebuildEdgeIndex: () => this._rebuildEdgeIndex() }); }

  removeNode(id, workspaceId = 'default') {
    return runNodeDelete(this._nodeDeleteStoreApi(), id, workspaceId);
  }

  _nodeTagStoreApi() { return runNodeTagStoreApi(this); }

  addTag(nodeId, dim, weight, workspaceId = 'default') {
    return runNodeTag(this._nodeTagStoreApi(), nodeId, dim, weight, workspaceId);
  }

  _edgeWriteStoreApi() { return runEdgeWriteStoreApi(this, { indexEdge: edge => this._indexEdge(edge), recordEdgeTouch: (...args) => this._recordEdgeTouch(...args) }); }

  addEdge(fromId, toId, relation, opts = {}) {
    return runEdgeWrite(this._edgeWriteStoreApi(), fromId, toId, relation, opts);
  }

  _pruneStoreApi() { return runPruneStoreApi(this, { rebuildEdgeIndex: () => this._rebuildEdgeIndex() }); }

  prune(threshold, workspaceId = 'default') {
    return runGraphPrune(this._pruneStoreApi(), threshold, workspaceId);
  }

  _optimizeStoreApi() { return runOptimizeStoreApi(this, { deindex: storageKey => this._deindexLabelNode(storageKey), workspaceKeys: scope => this._workspaceNodeKeys(scope) }); }

  optimize(workspaceId = 'default') {
    return runGraphOptimize(this._optimizeStoreApi(), workspaceId);
  }
}

function install(Graph) {
  installGraphMethods(Graph, GraphWriteMethods);
}

module.exports = { install };
