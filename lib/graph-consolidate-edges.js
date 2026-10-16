'use strict';

const { normalizeWorkspaceId } = require('./graph-record-utils');

function workspaceKey(edge, ...parts) {
  return JSON.stringify([normalizeWorkspaceId(edge.workspaceId), ...parts]);
}

function consolidateEdges({ edges, dryRun = true, replaceEdges, rebuildIndex, save, logSaveError, auditRemoval = () => {} }) {
  const removed = [];
  const marked = new Set();
  const byPair = new Map();

  for (let i = 0; i < edges.length; i++) {
    if (edges[i].kistlama) continue;
    const key = workspaceKey(edges[i], edges[i].from, edges[i].to);
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(i);
  }

  for (const indices of byPair.values()) {
    const high = indices.filter(i => edges[i].weight >= 0.5);
    const low = indices.filter(i => edges[i].weight < 0.3);
    for (const index of low) {
      if (high.length > 0) {
        removed.push({
          idx: index,
          edge: edges[index],
          reason: `low-weight (${edges[index].weight}) superseded by high-weight (${edges[high[0]].weight}) for same pair`,
        });
        marked.add(index);
      }
    }
  }

  const byRelation = new Map();
  for (let i = 0; i < edges.length; i++) {
    if (marked.has(i) || edges[i].kistlama) continue;
    const key = workspaceKey(edges[i], edges[i].from, edges[i].relation);
    if (!byRelation.has(key)) byRelation.set(key, []);
    byRelation.get(key).push(i);
  }

  for (const indices of byRelation.values()) {
    const high = indices.filter(i => edges[i].weight >= 0.5);
    const low = indices.filter(i => edges[i].weight < 0.3);
    for (const index of low) {
      if (high.length > 0 && !marked.has(index)) {
        removed.push({
          idx: index,
          edge: edges[index],
          reason: `low-weight restriction (${edges[index].weight}) — subject already has high-weight '${edges[index].relation}'`,
        });
        marked.add(index);
      }
    }
  }

  if (!dryRun && removed.length > 0) {
    replaceEdges(edges.filter((_, index) => !marked.has(index)));
    rebuildIndex();
    for (const { edge, reason } of removed) auditRemoval(edge, reason);
    try {
      save();
    } catch (error) {
      logSaveError(error);
    }
  }

  return {
    dryRun,
    removed: removed.length,
    details: removed.map(({ edge, reason }) =>
      `${edge.from} → ${edge.to} (${edge.relation}, w:${edge.weight}): ${reason}`),
  };
}

module.exports = consolidateEdges;
module.exports.consolidateEdges = consolidateEdges;
