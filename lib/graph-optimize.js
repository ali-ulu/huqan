'use strict';

const { normalizeWorkspaceId } = require('./graph-record-utils');

const SECONDS_PER_DAY = 24 * 60 * 60;

function optimize(storeApi, workspaceId = 'default') {
  const scope = normalizeWorkspaceId(workspaceId);
  const now = Date.now();
  // #3009: iterate only this workspace's nodes through the index instead of
  // sweeping the whole node map. Storage keys, not ids, are what the node map
  // and deleteNode use.
  const nodes = storeApi.getNodes();
  const scopedKeys = storeApi.workspaceKeys(scope);
  // Capture connectivity before pruning: prune() may intentionally remove weak
  // edges, but that must not turn their endpoints into deletion candidates in
  // the same maintenance pass.
  const connectedBeforePrune = new Set();
  for (const storageKey of scopedKeys) {
    const node = nodes[storageKey];
    if (!node) continue;
    if (storeApi.getEdges(node.id, node.workspaceId).length > 0
      || storeApi.getInEdges(node.id, node.workspaceId).length > 0) {
      connectedBeforePrune.add(node.id);
    }
  }
  const pruned = storeApi.prune(scope);
  let removedNodes = 0;
  for (const storageKey of scopedKeys) {
    const node = nodes[storageKey];
    if (!node) continue;
    const elapsed = Math.max(0, now - node.lastAccessed) / 1000 / SECONDS_PER_DAY;
    const decayed = node.weight * Math.exp(-storeApi.decayLambda * elapsed);
    const outEdges = storeApi.getEdges(node.id, node.workspaceId);
    const inEdges = storeApi.getInEdges(node.id, node.workspaceId);
    if (decayed < 0.01 && !connectedBeforePrune.has(node.id)
      && outEdges.length === 0 && inEdges.length === 0) {
      storeApi.deleteNode(storageKey);
      storeApi.persistDeleteNode(node.id, normalizeWorkspaceId(node.workspaceId));
      storeApi.auditRemoval(node, decayed);
      removedNodes++;
    }
  }
  return { pruned, removedNodes };
}

module.exports = { optimize };
