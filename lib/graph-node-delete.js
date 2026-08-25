const {
  normalizeWorkspaceId,
  nodeStorageKey,
} = require('./graph-record-utils');

function removeNode(storeApi, id, workspaceId = 'default') {
  const node = storeApi.getNode(id, workspaceId);
  if (!node) return false;
  const storageKey = nodeStorageKey(id, workspaceId);
  storeApi.recordNode?.(storageKey);
  storeApi.deleteNode(storageKey);
  storeApi.removeIncidentEdges(id, node.workspaceId);
  storeApi.rebuildIndex();
  storeApi.persistDeleteEdges(id, normalizeWorkspaceId(workspaceId));
  storeApi.persistDeleteNode(id, normalizeWorkspaceId(workspaceId));
  return true;
}

module.exports = { removeNode };
