'use strict';

const {
  normalizeWorkspaceId,
  edgeIndexKey,
  cloneEdgeRecord,
  frozenEdgeView,
} = require('./graph-record-utils');
const { applyReadBounds, normalizeReadBounds } = require('./graph-read-bounds');

function projectFor(clone) {
  return clone ? cloneEdgeRecord : frozenEdgeView;
}

function getEdge(outIndex, fromId, toId, relation, workspaceId = 'default', options = {}) {
  const { scope, clone } = normalizeReadBounds(workspaceId, options);
  const out = outIndex.get(edgeIndexKey(fromId, scope)) || [];
  for (const edge of out) {
    if (edge.to === toId && edge.relation === relation && normalizeWorkspaceId(edge.workspaceId) === scope) {
      return projectFor(clone)(edge);
    }
  }
  return null;
}

function getEdgesBetween(outIndex, fromId, toId, workspaceId = 'default', options = {}) {
  const { scope, limit, offset, clone } = normalizeReadBounds(workspaceId, options);
  const matched = (outIndex.get(edgeIndexKey(fromId, scope)) || [])
    .filter(edge => edge.to === toId && normalizeWorkspaceId(edge.workspaceId) === scope);
  return applyReadBounds(matched, { limit, offset }).map(projectFor(clone));
}

function hasAnyEdge(outIndex, fromId, toId, workspaceId = 'default') {
  // Existence check only: unlike getEdgesBetween, this never clones records,
  // so hot paths (dream degree scans, validators) pay no allocation (#3012).
  const scope = normalizeWorkspaceId(
    workspaceId && typeof workspaceId === 'object' && !Array.isArray(workspaceId)
      ? workspaceId.workspaceId
      : workspaceId,
  );
  const out = outIndex.get(edgeIndexKey(fromId, scope)) || [];
  return out.some(edge => edge.to === toId && normalizeWorkspaceId(edge.workspaceId) === scope);
}

function getEdges(outIndex, nodeId, workspaceId = 'default', options = {}) {
  const { scope, limit, offset, clone } = normalizeReadBounds(workspaceId, options);
  const matched = (outIndex.get(edgeIndexKey(nodeId, scope)) || [])
    .filter(edge => normalizeWorkspaceId(edge.workspaceId) === scope);
  return applyReadBounds(matched, { limit, offset }).map(projectFor(clone));
}

function getInEdges(inIndex, nodeId, workspaceId = 'default', options = {}) {
  const { scope, limit, offset, clone } = normalizeReadBounds(workspaceId, options);
  const matched = (inIndex.get(edgeIndexKey(nodeId, scope)) || [])
    .filter(edge => normalizeWorkspaceId(edge.workspaceId) === scope);
  return applyReadBounds(matched, { limit, offset }).map(projectFor(clone));
}

function getAllEdges(edges, workspaceId = 'default', options = {}) {
  const { scope, limit, offset, clone } = normalizeReadBounds(workspaceId, options);
  const matched = edges
    .filter(edge => normalizeWorkspaceId(edge.workspaceId) === scope);
  return applyReadBounds(matched, { limit, offset }).map(projectFor(clone));
}

module.exports = {
  getEdge,
  getEdgesBetween,
  hasAnyEdge,
  getEdges,
  getInEdges,
  getAllEdges,
};
