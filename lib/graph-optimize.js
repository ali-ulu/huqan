'use strict';

const { normalizeWorkspaceId } = require('./graph-record-utils');

const SECONDS_PER_DAY = 24 * 60 * 60;

function optimize(storeApi, workspaceId = 'default') {
  const scope = normalizeWorkspaceId(workspaceId);
  const now = Date.now();
  // Capture connectivity before pruning: prune() may intentionally remove weak
  // edges, but that must not turn their endpoints into deletion candidates in
  // the same maintenance pass.
  const connectedBeforePrune = new Set();
  for (const node of Object.values(storeApi.getNodes())) {
    if (normalizeWorkspaceId(node.workspaceId) !== scope) continue;
    if (storeApi.getEdges(node.id, node.workspaceId).length > 0
      || storeApi.getInEdges(node.id, node.workspaceId).length > 0) {
      connectedBeforePrune.add(node.id);
    }
  }
  let pruned = storeApi.prune(scope);
  const nodes = storeApi.getNodes();
  const nodeIds = Object.keys(nodes).filter(id => normalizeWorkspaceId(nodes[id].workspaceId) === scope);
  let removedNodes = 0;
  for (const id of nodeIds) {
    const node = nodes[id];
    const elapsed = Math.max(0, now - node.lastAccessed) / 1000 / SECONDS_PER_DAY;
    const decayed = node.weight * Math.exp(-storeApi.decayLambda * elapsed);
    const outEdges = storeApi.getEdges(node.id, node.workspaceId);
    const inEdges = storeApi.getInEdges(node.id, node.workspaceId);
    if (decayed < 0.01 && !connectedBeforePrune.has(node.id)
      && outEdges.length === 0 && inEdges.length === 0) {
      storeApi.deleteNode(id);
      storeApi.persistDeleteNode(node.id, normalizeWorkspaceId(node.workspaceId));
      storeApi.auditRemoval(node, decayed);
      removedNodes++;
    }
  }
  return { pruned, removedNodes };
}

module.exports = { optimize };
