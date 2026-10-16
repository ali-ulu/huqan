const { buildAuditEvent } = require('./audit-log');
const {
  normalizeWorkspaceId,
  edgeIndexKey,
  edgeUpdateArgs,
  nowIso,
} = require('./graph-record-utils');
const { getCandidateClaims: readCandidateClaims } = require('./graph-candidate-claims-read');
const { createGraphStorePort } = require('./graph-store-port');

// #3011: store APIs that can change a durable record in place without their
// own persist call mark it on the graph's dirty tracker, so the next save
// writes only those rows. The marker is not a persistence decision of its own
// -- it is the same "this record changed" fact the write already carries.
function markNode(graph, storageKey) {
  graph._dirtyOrCreate?.().markNode(storageKey);
}

function markEdge(graph, edge) {
  graph._dirtyOrCreate?.().markEdge(edge);
}

function nodeWriteStoreApi(graph, hooks = {}) {
  return {
    readPersisted: (id, workspaceId) => {
      if (graph._db && graph._stmts) {
        return { enabled: true, existing: graph._stmts.getNode.get(id, workspaceId) };
      }
      return { enabled: false, existing: null };
    },
    get: storageKey => graph._nodes[storageKey],
    recordNode: storageKey => {
      graph._mutationRollback?.recordNode(storageKey);
      markNode(graph, storageKey);
    },
    set: (storageKey, value) => { graph._nodes[storageKey] = value; markNode(graph, storageKey); },
    // #3009: node-write mutates an existing record in place (label, weight,
    // provenance), so the label bucket must be refreshed after any add/update.
    // The callback is injected by the Graph method holder, the same way edge
    // indexing is (see edgeWriteStoreApi), so this module never reaches into
    // Graph's private surface.
    reindex: storageKey => hooks.reindex?.(storageKey),
    reindexVector: storageKey => hooks.reindexVector?.(storageKey),
    persist: ({ id, workspaceId, label, weight, created, createdAt, lastAccessed, lastSeen, vector, provenance }) => {
      graph._stmts.upsertNode.run(
        id, workspaceId, label, weight, created, createdAt,
        lastAccessed, lastSeen, vector, provenance,
      );
    },
  };
}

function nodeTouchStoreApi(graph) {
  return {
    get: storageKey => graph._nodes[storageKey],
    recordNode: storageKey => {
      graph._mutationRollback?.recordNode(storageKey);
      markNode(graph, storageKey);
    },
    persist: (accessedAt, id, workspaceId) => (
      graph._db && graph._stmts && graph._stmts.touchNode.run(accessedAt, id, workspaceId)
    ),
  };
}

function appendAuditEvent(graph, event, opts = {}) {
  const normalized = buildAuditEvent(event, opts);
  graph._auditEvents.push(normalized);
  if (graph._db && graph._stmts) {
    graph._stmts.insertAuditEvent.run(
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

function auditQueryContext(graph) {
  return {
    db: graph._db,
    stmts: graph._stmts,
    events: graph._auditEvents,
    statementCache: graph._auditQueryStmts,
  };
}

function candidateClaimWriteStoreApi(graph) {
  return {
    recordCandidateClaim: index => graph._mutationRollback?.recordCandidateClaim(index),
    findIndex: (candidateId, workspaceId) => graph._candidateClaims.findIndex(item =>
      item.candidateId === candidateId && normalizeWorkspaceId(item.workspaceId) === workspaceId
    ),
    get: index => graph._candidateClaims[index],
    replace: (index, value) => { graph._candidateClaims[index] = value; },
    append: value => { graph._candidateClaims.push(value); },
    persist: (normalized, workspaceId) => {
      if (graph._db && graph._stmts) {
        graph._stmts.upsertCandidateClaim.run(
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
    read: filters => readCandidateClaims(graph._candidateClaims, filters),
  };
}

function nodeDeleteStoreApi(graph, hooks = {}) {
  return {
    getNode: (id, workspaceId) => graph.getNode(id, workspaceId),
    recordNode: storageKey => graph._mutationRollback?.recordNode(storageKey),
    deleteNode: storageKey => { hooks.deindex?.(storageKey); hooks.deindexVector?.(storageKey); delete graph._nodes[storageKey]; },
    removeIncidentEdges: (id, workspaceId) => (
      graph._edges = graph._edges.filter(edge =>
        !(edge.workspaceId === workspaceId && (edge.from === id || edge.to === id))
      )
    ),
    // #3009: removing a node changes only `_edges` for the index; the label
    // index was already updated incrementally in deleteNode, so `_nodes` is not
    // rescanned here. Injected so this module keeps off Graph's private surface.
    rebuildIndex: () => hooks.rebuildEdgeIndex?.(),
    persistDeleteEdges: (id, workspaceId) => (
      graph._db && graph._stmts && graph._stmts.deleteEdgesOf.run(id, id, workspaceId)
    ),
    persistDeleteNode: (id, workspaceId) => (
      graph._db && graph._stmts && graph._stmts.deleteNode.run(id, workspaceId)
    ),
  };
}

function nodeTagStoreApi(graph, hooks = {}) {
  return {
    get: storageKey => graph._nodes[storageKey],
    recordNode: storageKey => {
      graph._mutationRollback?.recordNode(storageKey);
      markNode(graph, storageKey);
    },
    reindex: storageKey => hooks.reindex?.(storageKey),
  };
}

function edgeWriteStoreApi(graph, { indexEdge, recordEdgeTouch }) {
  return {
    hasNode: (id, workspaceId) => Boolean(graph.getNode(id, workspaceId)),
    touchNode: (id, workspaceId) => graph.touchNode(id, workspaceId),
    findExisting: (fromId, toId, relation, workspaceId) => (
      (graph._outIndex.get(edgeIndexKey(fromId, workspaceId)) || []).find(
        edge => edge.to === toId
          && edge.relation === relation
          && normalizeWorkspaceId(edge.workspaceId) === workspaceId
      ) || null
    ),
    recordEdge: edge => {
      graph._mutationRollback?.recordEdge(edge);
      markEdge(graph, edge);
    },
    append: edge => {
      graph._edges.push(edge);
      indexEdge(edge);
      // Every edge in memory is dirty by construction: a new edge is written by
      // persistCreate immediately, but marking it here keeps the delta complete
      // if a path ever appends without persisting.
      markEdge(graph, edge);
    },
    persistUpdate: (edge, workspaceId, fromId, toId, relation, isoNow) => {
      if (!graph._db || !graph._stmts) return;
      graph._stmts.updateEdgeWeight.run(
        ...edgeUpdateArgs(edge, workspaceId, fromId, toId, relation, isoNow),
      );
    },
    persistCreate: (edge, workspaceId, fromId, toId, relation, isoNow) => {
      if (!graph._db || !graph._stmts) return;
      graph._stmts.upsertEdge.run(
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
      recordEdgeTouch(workspaceId, fromId, relation, toId);
    },
  };
}

function pruneStoreApi(graph, hooks = {}) {
  return {
    getEdges: () => graph._edges,
    setEdges: edges => { graph._edges = edges; },
    // #3009: prune only rewrites `_edges`, so only the edge index is rebuilt;
    // the label index is untouched. Injected to avoid Graph's private surface.
    rebuildIndex: () => hooks.rebuildEdgeIndex?.(),
    getPruneThreshold: () => graph._pruneThreshold,
    persistPrune: (threshold, scope) => {
      if (graph._db) graph._stmts.pruneEdges.run(threshold, scope);
    },
  };
}

function optimizeStoreApi(graph, hooks = {}) {
  return {
    prune: scope => graph.prune(undefined, scope),
    getNodes: () => graph._nodes,
    workspaceKeys: scope => hooks.workspaceKeys?.(scope),
    getEdges: (nodeId, scope) => graph.getEdges(nodeId, scope),
    getInEdges: (nodeId, scope) => graph.getInEdges(nodeId, scope),
    decayLambda: graph._decayLambda,
    recordNode: id => graph._mutationRollback?.recordNode(id),
    deleteNode: id => {
      graph._mutationRollback?.recordNode(id);
      hooks.deindex?.(id);
      hooks.deindexVector?.(id);
      delete graph._nodes[id];
    },
    persistDeleteNode: (id, scope) => {
      if (graph._db && graph._stmts) graph._stmts.deleteNode.run(id, scope);
    },
    auditRemoval: (node, decayedWeight) => graph.appendAuditEvent({
      eventType: 'DELETE',
      targetType: 'node',
      targetId: node.id,
      workspaceId: normalizeWorkspaceId(node.workspaceId),
      actor: 'graph.optimize',
      sourceRef: 'graph.optimize',
      details: { reason: 'decayed_isolated_node', decayedWeight },
    }),
  };
}

function statsStoreApi(graph) {
  return {
    nodeCount: () => graph.nodeCount(),
    edgeCount: () => graph.edgeCount(),
    candidateClaims: graph._candidateClaims,
    decayLambda: graph._decayLambda,
    hasSqlite: Boolean(graph._db),
  };
}

module.exports = {
  nodeWriteStoreApi,
  nodeTouchStoreApi,
  appendAuditEvent,
  auditQueryContext,
  candidateClaimWriteStoreApi,
  nodeDeleteStoreApi,
  nodeTagStoreApi,
  edgeWriteStoreApi,
  pruneStoreApi,
  optimizeStoreApi,
  statsStoreApi,
  createGraphStorePort,
};
