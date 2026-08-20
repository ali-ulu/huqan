'use strict';

const { normalizeWorkspaceId } = require('./graph-record-utils');

function countNodes(nodes, workspaceId) {
  if (!workspaceId) return Object.keys(nodes).length;
  const scope = normalizeWorkspaceId(workspaceId);
  return Object.values(nodes).filter(node => normalizeWorkspaceId(node.workspaceId) === scope).length;
}

function countEdges(edges, workspaceId) {
  if (!workspaceId) return edges.length;
  const scope = normalizeWorkspaceId(workspaceId);
  return edges.filter(edge => normalizeWorkspaceId(edge.workspaceId) === scope).length;
}

module.exports = { countNodes, countEdges };
