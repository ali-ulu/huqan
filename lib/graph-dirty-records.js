'use strict';

// Incremental-save bookkeeping for the SQLite graph backend (#3011).
//
// `save()` used to rewrite every node and edge row in one transaction on every
// call, so its cost scaled with graph size (~32 ms at 500 nodes, ~231 ms at 2k,
// 1.45 s at 10k -- see lib/graph-sqlite-pragmas.js) and blocked the event loop
// for that whole window. Most graph writes already reach SQLite through their
// per-operation store API, so the full rewrite was mostly redundant work on
// rows that had not changed.
//
// This tracker records only the records a mutation touched since the last
// save, so `save()` can apply the delta in O(change size). It is derived
// state, like `_outIndex` / `_labelIndex`: it is cleared after a successful
// save and on load, and it never decides what the graph contains -- only what
// still needs writing. Record removals are not tracked here: every removal
// path deletes its own row immediately (`persistDeleteNode`,
// `persistDeleteEdges`, `persistPrune`), so there is nothing left to write.

function createDirtyRecords() {
  // Node storage keys whose row must be (re)written.
  const nodes = new Set();
  // Live edge object references; edges are mutated in place, so the reference
  // is enough to read the current field values at save time.
  const edges = new Set();

  return {
    markNode(storageKey) {
      if (storageKey) nodes.add(storageKey);
    },
    markEdge(edge) {
      if (edge) edges.add(edge);
    },
    clear() {
      nodes.clear();
      edges.clear();
    },
    get pending() {
      return nodes.size + edges.size;
    },
    nodeKeys() { return [...nodes]; },
    edgeRecords() { return [...edges]; },
  };
}

module.exports = { createDirtyRecords };
