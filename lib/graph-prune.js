'use strict';

const { normalizeWorkspaceId } = require('./graph-record-utils');

function prune(storeApi, threshold, workspaceId = 'default') {
  if (threshold === undefined) threshold = storeApi.getPruneThreshold();
  const scope = normalizeWorkspaceId(workspaceId);
  const currentEdges = storeApi.getEdges();
  const before = currentEdges.filter(edge => normalizeWorkspaceId(edge.workspaceId) === scope).length;
  storeApi.setEdges(currentEdges.filter(edge => normalizeWorkspaceId(edge.workspaceId) !== scope || edge.weight >= threshold));
  storeApi.rebuildIndex();
  const after = storeApi.getEdges().filter(edge => normalizeWorkspaceId(edge.workspaceId) === scope).length;
  const pruned = before - after;
  if (pruned > 0) storeApi.persistPrune(threshold, scope);
  return pruned;
}

module.exports = { prune };
