'use strict';

const {
  cloneNodeRecord,
  frozenNodeView,
  nodeStorageKey,
  normalizeWorkspaceId,
} = require('./graph-record-utils');
const { applyReadBounds, normalizeReadBounds } = require('./graph-read-bounds');

function workspaceIdFromArgument(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value.workspaceId : value;
}

function getNodes(nodes, workspaceId = 'default', options = {}) {
  const { scope, limit, offset, clone } = normalizeReadBounds(workspaceId, options);
  const project = clone ? cloneNodeRecord : frozenNodeView;
  const scoped = [];
  // Keyed by node.id, not the map's own key -- the map key is the internal
  // storage key (nodeStorageKey), which is scope-prefixed for every
  // workspace except 'default' (#1294). Consumers must see one consistent
  // key shape regardless of workspace, the same way getNode already does.
  for (const node of Object.values(nodes)) {
    if (normalizeWorkspaceId(node.workspaceId) === scope) {
      scoped.push(node);
    }
  }
  const scopedNodes = {};
  for (const node of applyReadBounds(scoped, { limit, offset })) {
    scopedNodes[node.id] = project(node);
  }
  return scopedNodes;
}

function getNode(nodes, id, workspaceId = 'default', options = {}) {
  const { scope, clone } = normalizeReadBounds(workspaceId, options);
  const storageKey = nodeStorageKey(id, scope);
  const node = nodes[storageKey] || (scope === 'default' ? nodes[id] : null);
  if (!node || normalizeWorkspaceId(node.workspaceId) !== scope) return null;
  return clone ? cloneNodeRecord(node) : frozenNodeView(node);
}

module.exports = {
  getNode,
  getNodes,
};
