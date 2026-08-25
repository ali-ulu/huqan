'use strict';

/**
 * Pre-image capture and restore for a failed graph mutation (#1134).
 *
 * runMutationOnce has to be able to put the in-memory graph back exactly as it
 * was when a mutation throws. It did that by deep-cloning all four pieces of
 * mutable state before every mutation, which made the cost of *attempting* a
 * mutation proportional to everything the graph held, not to what the mutation
 * touched.
 *
 * Two of the four never needed a deep copy:
 *
 * - `auditEvents` is append-only. Graph.appendAuditEvent() is its single
 *   writer and only pushes, so the pre-image is a length and the restore is a
 *   truncation. Deep-cloning it tied mutation cost to the audit log rather
 *   than the graph: measured on a 200-node graph, 1.9 ms/mutation with an
 *   empty log and 33 ms with 20k events -- for a log the mutation never reads.
 * - `candidateClaims` elements are replaced wholesale by
 *   graph-candidate-claims-write (`replace(index, { ...get(index), ... })`),
 *   never edited in place, so a shallow array copy restores them exactly.
 *
 * Nodes and edges do need copying: mutations edit those records in place
 * (weight bumps, confidence history, lastAccessed). That is the remaining
 * O(graph) cost per mutation, and closing it means delta/undo-log rollback
 * rather than a cheaper snapshot -- a different change from this one.
 */

/**
 * @param {object} state - { nodes, edges, candidateClaims, auditEvents }
 * @param {object} clone - { cloneNodeMap, deepClone } from the caller, so this
 *   module does not pick its own cloning strategy for node/edge records.
 */
function createMutationRollbackSnapshot(state, clone) {
  return {
    nodes: clone.cloneNodeMap(state.nodes),
    edges: clone.deepClone(state.edges),
    candidateClaims: [...state.candidateClaims],
    auditEventCount: state.auditEvents.length,
  };
}

/**
 * @param {object} storeApi - setters owned by Graph; this module never holds a
 *   graph receiver.
 * @param {object} snapshot - the value returned by createMutationRollbackSnapshot
 */
function restoreMutationRollbackSnapshot(storeApi, snapshot) {
  storeApi.setNodes(snapshot.nodes);
  storeApi.setEdges(snapshot.edges);
  storeApi.setCandidateClaims(snapshot.candidateClaims);
  // Truncation, not replacement: whatever the failed mutation appended is
  // dropped, and every older event keeps its identity.
  storeApi.truncateAuditEvents(snapshot.auditEventCount);
  storeApi.rebuildIndexes();
}

module.exports = { createMutationRollbackSnapshot, restoreMutationRollbackSnapshot };
