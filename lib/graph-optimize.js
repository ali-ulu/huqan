'use strict';

const { normalizeWorkspaceId } = require('./graph-record-utils');

function optimize(storeApi, workspaceId = 'default') {
  const scope = normalizeWorkspaceId(workspaceId);
  const now = Date.now();
  let pruned = storeApi.prune(scope);
  const nodes = storeApi.getNodes();
  const nodeIds = Object.keys(nodes).filter(id => normalizeWorkspaceId(nodes[id].workspaceId) === scope);
  let removedNodes = 0;
  for (const id of nodeIds) {
    const node = nodes[id];
    const elapsed = (now - node.lastAccessed) / 1000;
    const decayed = node.weight * Math.exp(-storeApi.decayLambda * elapsed);
    const outEdges = storeApi.getEdges(node.id, node.workspaceId);
    const inEdges = storeApi.getInEdges(node.id, node.workspaceId);
    if (decayed < 0.01 && outEdges.length === 0 && inEdges.length === 0) {
      storeApi.deleteNode(id);
      storeApi.persistDeleteNode(node.id, normalizeWorkspaceId(node.workspaceId));
      removedNodes++;
    }
  }
  return { pruned, removedNodes };
}

module.exports = { optimize };
