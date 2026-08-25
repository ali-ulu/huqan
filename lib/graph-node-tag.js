const {
  normalizeWorkspaceId,
  nodeStorageKey,
} = require('./graph-record-utils');

function addTag(storeApi, nodeId, dim, weight, workspaceId = 'default') {
  const storageKey = nodeStorageKey(nodeId, workspaceId);
  const scope = normalizeWorkspaceId(workspaceId);
  const node = storeApi.get(storageKey) || (scope === 'default' ? storeApi.get(nodeId) : null);
  if (!node) return;
  storeApi.recordNode?.(storageKey);
  const v = node.vector;
  v[dim] = (v[dim] || 0) + weight;
}

module.exports = { addTag };
