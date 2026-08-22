'use strict';

const {
  cloneNodeRecord,
  nodeStorageKey,
  normalizeWorkspaceId,
} = require('./graph-record-utils');

function workspaceIdFromArgument(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value.workspaceId : value;
}

function getNodes(nodes, workspaceId = 'default') {
  const scope = normalizeWorkspaceId(workspaceIdFromArgument(workspaceId));
  const scopedNodes = {};
  for (const [id, node] of Object.entries(nodes)) {
    if (normalizeWorkspaceId(node.workspaceId) === scope) {
      scopedNodes[id] = cloneNodeRecord(node);
    }
  }
  return scopedNodes;
}

function getNode(nodes, id, workspaceId = 'default') {
  const scope = normalizeWorkspaceId(workspaceIdFromArgument(workspaceId));
  const storageKey = nodeStorageKey(id, scope);
  const node = nodes[storageKey] || (scope === 'default' ? nodes[id] : null);
  if (!node || normalizeWorkspaceId(node.workspaceId) !== scope) return null;
  return cloneNodeRecord(node);
}

module.exports = {
  getNode,
  getNodes,
};
