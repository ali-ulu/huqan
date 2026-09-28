'use strict';

// Graph's read methods, moved out of graph.js unchanged (#3101): node, edge,
// candidate-claim, audit, count, query, similarity, stats and causal reads.
// None of them writes. Installed on Graph.prototype by graph.js with the
// descriptors they had as class methods; `this` is the Graph instance.

const { CAUSAL_RELATIONS, compareCausalEdges } = require('./graph-record-utils');
const { countAuditEvents, queryAuditEvents, readAuditEvents } = require('./audit-query');
const { getCausalChain: runCausalChain } = require('./graph-causal-chain');
const { getCandidateClaims: runCandidateClaimsRead } = require('./graph-candidate-claims-read');
const {
  getEdge: runEdgeRead,
  getEdgesBetween: runEdgesBetweenRead,
  hasAnyEdge: runHasAnyEdgeRead,
  getEdges: runEdgesRead,
  getInEdges: runInEdgesRead,
  getAllEdges: runAllEdgesRead,
} = require('./graph-edge-read');
const { getNode: runNodeRead, getNodes: runNodesRead } = require('./graph-node-read');
const { getWeight: runNodeWeight } = require('./graph-node-weight');
const { cosineSimilarity: runNodeSimilarity } = require('./graph-node-similarity');
const { getStats: runGraphStats } = require('./graph-stats');
const { countNodes: runNodeCount, countEdges: runEdgeCount } = require('./graph-count-read');
const { query: runGraphQuery } = require('./graph-query-read');
const { isCausalRelation: runIsCausalRelation, getCausalRelations: runCausalRelations, getCausalEdges: runCausalEdges } = require('./graph-causal-relation-read');
const { statsStoreApi: runStatsStoreApi } = require('./graph-store-adapters');
const { installGraphMethods } = require('./graph-method-install');

class GraphReadMethods {
  getNodes(workspaceId = 'default') {
    return runNodesRead(this._nodes, workspaceId, scope => this._workspaceNodeKeys(scope));
  }

  getNode(id, workspaceId = 'default') {
    return runNodeRead(this._nodes, id, workspaceId);
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

  getCandidateClaims(filters = {}) {
    return runCandidateClaimsRead(this._candidateClaims, filters);
  }

  getWeight(id, workspaceId = 'default') {
    return runNodeWeight((nodeId, scope) => this.getNode(nodeId, scope), this._decayLambda, id, workspaceId);
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
    return runGraphQuery(this._nodes, label, workspaceId, this._labelIndex);
  }

  nodeCount(workspaceId) {
    return runNodeCount(this._nodes, workspaceId, this._labelIndex);
  }

  edgeCount(workspaceId) {
    return runEdgeCount(this._edges, workspaceId, this._edgeWorkspaceCounts);
  }

  cosineSimilarity(aId, bId, workspaceId = 'default') {
    return runNodeSimilarity((nodeId, scope) => this.getNode(nodeId, scope), aId, bId, workspaceId);
  }

  _statsStoreApi() { return runStatsStoreApi(this); }

  getStats() {
    return runGraphStats(this._statsStoreApi());
  }

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
}

function install(Graph) {
  installGraphMethods(Graph, GraphReadMethods);
}

module.exports = { install };
