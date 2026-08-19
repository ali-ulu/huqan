const {
  normalizeWorkspaceId,
  nodeStorageKey,
  cloneNodeRecord,
} = require('./graph-record-utils');

function touchNode(storeApi, id, workspaceId = 'default') {
  const scope = normalizeWorkspaceId(workspaceId);
  const storageKey = nodeStorageKey(id, scope);
  const node = storeApi.get(storageKey);
  if (!node || normalizeWorkspaceId(node.workspaceId) !== scope) return null;
  const accessedAt = Date.now();
  node.lastAccessed = accessedAt;
  storeApi.persist(accessedAt, id, scope);
  return cloneNodeRecord(node);
}

module.exports = { touchNode };
