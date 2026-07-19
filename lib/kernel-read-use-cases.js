'use strict';

function createKernelReadUseCases({ getGraph }) {
  if (typeof getGraph !== 'function') {
    throw new TypeError('getGraph is required');
  }

  function graph() {
    return getGraph();
  }

  return Object.freeze({
    entropy(workspaceId = 'default') {
      const currentGraph = graph();
      const allNodes = Object.values(currentGraph.getNodes(workspaceId));
      if (allNodes.length === 0) return 0;

      let totalWeight = 0;
      const weights = [];

      for (const node of allNodes) {
        const edges = currentGraph.getEdges(node.id, workspaceId);
        for (const edge of edges) {
          weights.push(edge.weight);
          totalWeight += edge.weight;
        }
      }

      if (totalWeight === 0) return 0;

      let entropy = 0;
      for (const weight of weights) {
        const probability = weight / totalWeight;
        entropy -= probability * Math.log(probability);
      }

      return entropy;
    },

    detectGaps(workspaceId = 'default') {
      const currentGraph = graph();
      const allNodes = Object.values(currentGraph.getNodes(workspaceId));
      const gaps = [];

      for (const node of allNodes) {
        const edges = currentGraph.getEdges(node.id, workspaceId);
        if (edges.length === 0) {
          gaps.push(node.id);
        }
      }

      return gaps;
    },
  });
}

module.exports = {
  createKernelReadUseCases,
};
