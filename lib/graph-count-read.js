'use strict';

const { normalizeWorkspaceId } = require('./graph-record-utils');
const { workspaceNodeCount } = require('./graph-label-index');

// #3009: the total count is still O(1) (`Object.keys(nodes).length`), and the
// workspace count now reads the label index's per-workspace counter instead of
// scanning every node. `nodes` is accepted so the total path keeps its shape.
function countNodes(nodes, workspaceId, labelIndex) {
  if (!workspaceId) return Object.keys(nodes).length;
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
