'use strict';

const {
  cloneNodeRecord,
  cloneEdgeRecord,
  deepClone,
} = require('./graph-record-utils');

function restoreRecord(target, snapshot) {
  for (const key of Object.keys(target)) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, key)) delete target[key];
  }
  Object.assign(target, snapshot);
}

/**
 * Lazy rollback journal for Graph.runMutationOnce().
 *
 * The old rollback pre-image cloned every node and edge before every mutation.
 * Most mutations touch a small, known set of records, so this journal captures
 * only those records when their canonical write path is entered. Append-only
 * audit events, replace-or-append candidate claims, and collection roots use
 * length/reference pre-images instead of graph-wide deep clones.
 *
 * SQLite still supplies the durable transaction. This module only restores the
 * in-memory graph when the callback, receipt builder, or persistence step fails.
 */
function createMutationRollback(graph) {
  const nodeRoot = graph._nodes;
  const edgeRoot = graph._edges;
  const candidateRoot = graph._candidateClaims;
  const auditRoot = graph._auditEvents;
  const edgeLength = edgeRoot.length;
  const candidateLength = candidateRoot.length;
  const auditLength = auditRoot.length;
  const nodes = new Map();
  const edges = new Map();
  const candidates = new Map();

  return {
    recordNode(storageKey) {
      if (nodes.has(storageKey)) return;
      const node = nodeRoot[storageKey];
      nodes.set(storageKey, node ? cloneNodeRecord(node) : null);
    },

    recordEdge(edge) {
      if (!edge || edges.has(edge)) return;
      edges.set(edge, cloneEdgeRecord(edge));
    },

    recordCandidateClaim(index) {
      if (candidates.has(index)) return;
      candidates.set(index, {
        exists: index >= 0 && index < candidateLength,
        value: index >= 0 && index < candidateLength
          ? deepClone(candidateRoot[index])
          : undefined,
      });
    },

    restore() {
      graph._nodes = nodeRoot;
      for (const [storageKey, snapshot] of nodes) {
        if (snapshot === null) delete nodeRoot[storageKey];
        else nodeRoot[storageKey] = snapshot;
      }

      graph._edges = edgeRoot;
      edgeRoot.length = edgeLength;
      for (const [edge, snapshot] of edges) restoreRecord(edge, snapshot);

      graph._candidateClaims = candidateRoot;
      candidateRoot.length = candidateLength;
      for (const [index, snapshot] of candidates) {
        if (!snapshot.exists) continue;
        candidateRoot[index] = snapshot.value;
      }

      graph._auditEvents = auditRoot;
      auditRoot.length = auditLength;
      graph._outIndex.clear();
      graph._inIndex.clear();
      graph._rebuildIndex();
    },
  };
}

module.exports = { createMutationRollback };
