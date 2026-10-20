'use strict';

const { normalizeWorkspaceId } = require('./graph-record-utils');
const { workspaceNodeCount } = require('./graph-label-index');

// The label index tracks every storage key; bare-map callers retain the scan.
function countNodes(nodes, workspaceId, labelIndex) {
  if (!workspaceId) return labelIndex ? labelIndex.owner.size : Object.keys(nodes).length;
  return workspaceNodeCount(labelIndex, workspaceId);
}

// #3139: the workspace edge count reads Graph's per-workspace counter when one
// is supplied; without it the function still scans, so it stays usable on a
// bare edge array.
function countEdges(edges, workspaceId, edgeCounts) {
  if (!workspaceId) return edges.length;
  const scope = normalizeWorkspaceId(workspaceId);
  if (edgeCounts) return edgeCounts.get(scope) || 0;
  return edges.filter(edge => normalizeWorkspaceId(edge.workspaceId) === scope).length;
}

module.exports = { countNodes, countEdges };
