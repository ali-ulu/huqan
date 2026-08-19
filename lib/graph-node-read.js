'use strict';

const {
  cloneNodeRecord,
  nodeStorageKey,
  normalizeWorkspaceId,
} = require('./graph-record-utils');

function getNodes(nodes, workspaceId = 'default') {
  const scope = normalizeWorkspaceId(workspaceId);
  const scopedNodes = {};
  for (const [id, node] of Object.entries(nodes)) {
    if (normalizeWorkspaceId(node.workspaceId) === scope) {
      scopedNodes[id] = cloneNodeRecord(node);
    }
  }
  return scopedNodes;
}

function getNode(nodes, id, workspaceId = 'default') {
  const scope = normalizeWorkspaceId(workspaceId);
  const storageKey = nodeStorageKey(id, scope);
  const node = nodes[storageKey] || (scope === 'default' ? nodes[id] : null);
  if (!node || normalizeWorkspaceId(node.workspaceId) !== scope) return null;
  return cloneNodeRecord(node);
}

module.exports = {
  getNode,
  getNodes,
};
