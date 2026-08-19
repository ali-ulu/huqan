'use strict';

const {
  normalizeWorkspaceId,
  edgeIndexKey,
  cloneEdgeRecord,
} = require('./graph-record-utils');

function getEdge(outIndex, fromId, toId, relation, workspaceId = 'default') {
  const out = outIndex.get(edgeIndexKey(fromId, workspaceId)) || [];
  for (const edge of out) {
    if (edge.to === toId && edge.relation === relation && normalizeWorkspaceId(edge.workspaceId) === normalizeWorkspaceId(workspaceId)) {
      return cloneEdgeRecord(edge);
    }
  }
  return null;
}

function getEdgesBetween(outIndex, fromId, toId, workspaceId = 'default') {
  const out = outIndex.get(edgeIndexKey(fromId, workspaceId)) || [];
  return out
    .filter(edge => edge.to === toId && normalizeWorkspaceId(edge.workspaceId) === normalizeWorkspaceId(workspaceId))
    .map(cloneEdgeRecord);
}

function hasAnyEdge(outIndex, fromId, toId, workspaceId = 'default') {
  return getEdgesBetween(outIndex, fromId, toId, workspaceId).length > 0;
}

function getEdges(outIndex, nodeId, workspaceId = 'default') {
  const out = outIndex.get(edgeIndexKey(nodeId, workspaceId)) || [];
  return out
    .filter(edge => normalizeWorkspaceId(edge.workspaceId) === normalizeWorkspaceId(workspaceId))
    .map(cloneEdgeRecord);
}

function getInEdges(inIndex, nodeId, workspaceId = 'default') {
  const out = inIndex.get(edgeIndexKey(nodeId, workspaceId)) || [];
  return out
    .filter(edge => normalizeWorkspaceId(edge.workspaceId) === normalizeWorkspaceId(workspaceId))
    .map(cloneEdgeRecord);
}

function getAllEdges(edges, workspaceId = 'default') {
  return edges
    .filter(edge => normalizeWorkspaceId(edge.workspaceId) === normalizeWorkspaceId(workspaceId))
    .map(cloneEdgeRecord);
}

module.exports = {
  getEdge,
  getEdgesBetween,
  hasAnyEdge,
  getEdges,
  getInEdges,
  getAllEdges,
};
