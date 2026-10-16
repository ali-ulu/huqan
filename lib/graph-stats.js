'use strict';

function getStats(store) {
  return {
    nodes: store.nodeCount(),
    edges: store.edgeCount(),
    candidateClaims: store.candidateClaims.length,
    decayLambda: store.decayLambda,
    backend: store.hasSqlite ? 'sqlite' : 'json',
  };
}

module.exports = { getStats };
