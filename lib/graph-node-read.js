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
  // Keyed by node.id, not the map's own key -- the map key is the internal
  // storage key (nodeStorageKey), which is scope-prefixed for every
  // workspace except 'default' (#1294). Consumers must see one consistent
  // key shape regardless of workspace, the same way getNode already does.
  for (const node of Object.values(nodes)) {
    if (normalizeWorkspaceId(node.workspaceId) === scope) {
      scopedNodes[node.id] = cloneNodeRecord(node);
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
