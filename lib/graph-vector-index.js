'use strict';

const { normalizeWorkspaceId } = require('./graph-record-utils');

function createVectorIndex() {
  return { buckets: new Map(), dimensions: new Map(), unsafeWorkspaces: new Set(),
    unsafeKeys: new Map(), unsafeCounts: new Map() };
}

function releaseUnsafeMembership(index, storageKey) {
  const workspaceId = index.unsafeKeys?.get(storageKey);
  if (workspaceId === undefined) return;
  index.unsafeKeys.delete(storageKey);
  const remaining = (index.unsafeCounts?.get(workspaceId) || 1) - 1;
  if (remaining <= 0) {
    index.unsafeCounts?.delete(workspaceId);
    index.unsafeWorkspaces.delete(workspaceId);
  } else {
    index.unsafeCounts?.set(workspaceId, remaining);
  }
}

function deindexNode(index, storageKey) {
  releaseUnsafeMembership(index, storageKey);
  const previous = index.dimensions.get(storageKey);
  if (!previous) return;
  for (const [workspaceId, dimension] of previous) {
    const workspace = index.buckets.get(workspaceId);
    const bucket = workspace?.get(dimension);
    bucket?.delete(storageKey);
    if (bucket?.size === 0) workspace.delete(dimension);
  }
  index.dimensions.delete(storageKey);
}

function indexNode(index, storageKey, node) {
  deindexNode(index, storageKey);
  if (!node) return;
  const workspaceId = normalizeWorkspaceId(node.workspaceId);
  const vector = node.vector;
  if (!vector || typeof vector !== 'object' || Array.isArray(vector) ||
      !Object.values(vector).every(Number.isFinite)) {
    index.unsafeKeys?.set(storageKey, workspaceId);
    index.unsafeCounts?.set(workspaceId, (index.unsafeCounts?.get(workspaceId) || 0) + 1);
    index.unsafeWorkspaces.add(workspaceId);
    return;
  }
  if (!index.buckets.has(workspaceId)) index.buckets.set(workspaceId, new Map());
  const workspace = index.buckets.get(workspaceId);
  const dimensions = [];
  for (const [dimension, value] of Object.entries(vector)) {
    if (value === 0) continue;
    if (!workspace.has(dimension)) workspace.set(dimension, new Set());
    workspace.get(dimension).add(storageKey);
    dimensions.push([workspaceId, dimension]);
  }
  index.dimensions.set(storageKey, dimensions);
}

function rebuildVectorIndex(index, nodes) {
  index.buckets.clear();
  index.dimensions.clear();
  index.unsafeWorkspaces.clear();
  index.unsafeKeys?.clear();
  index.unsafeCounts?.clear();
  for (const [storageKey, node] of Object.entries(nodes)) indexNode(index, storageKey, node);
}

function candidateIds(index, nodes, vector, workspaceId = 'default') {
  const scope = normalizeWorkspaceId(workspaceId);
  if (index.unsafeWorkspaces.has(scope) || !vector || typeof vector !== 'object' ||
      Array.isArray(vector) || !Object.values(vector).every(Number.isFinite)) return null;
  const workspace = index.buckets.get(scope);
  if (!workspace) return [];
  const keys = new Set();
  for (const [dimension, value] of Object.entries(vector)) {
    if (value === 0) continue;
    for (const key of workspace.get(dimension) || []) keys.add(key);
  }
  return [...keys].map((key) => nodes[key]?.id).filter(Boolean);
}

module.exports = { createVectorIndex, indexNode, deindexNode, rebuildVectorIndex, candidateIds };
