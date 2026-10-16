'use strict';

const { normalizeWorkspaceId } = require('./graph-record-utils');

function createVectorIndex() {
  return { buckets: new Map(), dimensions: new Map(), unsafeWorkspaces: new Set(),
    unsafeKeys: new Map(), unsafeCounts: new Map(), magnitudes: new Map(), sorted: new Map() };
}

function isSafeVector(vector) {
  return !!vector && typeof vector === 'object' && !Array.isArray(vector) &&
    Object.values(vector).every(Number.isFinite);
}

// Sorted per-dimension lists are built on first read and dropped whenever a
// member of that bucket changes, because a node's normalized weight depends
// on all of its dimensions.
function invalidateSorted(index, workspaceId, dimension) {
  index.sorted?.get(workspaceId)?.delete(dimension);
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
    invalidateSorted(index, workspaceId, dimension);
  }
  index.dimensions.delete(storageKey);
  index.magnitudes?.delete(storageKey);
}

function indexNode(index, storageKey, node) {
  deindexNode(index, storageKey);
  if (!node) return;
  const workspaceId = normalizeWorkspaceId(node.workspaceId);
  const vector = node.vector;
  if (!isSafeVector(vector)) {
    index.unsafeKeys?.set(storageKey, workspaceId);
    index.unsafeCounts?.set(workspaceId, (index.unsafeCounts?.get(workspaceId) || 0) + 1);
    index.unsafeWorkspaces.add(workspaceId);
    return;
  }
  if (!index.buckets.has(workspaceId)) index.buckets.set(workspaceId, new Map());
  const workspace = index.buckets.get(workspaceId);
  const dimensions = [];
  let squares = 0;
  for (const [dimension, value] of Object.entries(vector)) {
    if (value === 0) continue;
    if (!workspace.has(dimension)) workspace.set(dimension, new Set());
    workspace.get(dimension).add(storageKey);
    invalidateSorted(index, workspaceId, dimension);
    dimensions.push([workspaceId, dimension]);
    squares += value * value;
  }
  index.dimensions.set(storageKey, dimensions);
  index.magnitudes?.set(storageKey, Math.sqrt(squares));
}

function rebuildVectorIndex(index, nodes) {
  index.buckets.clear();
  index.dimensions.clear();
  index.unsafeWorkspaces.clear();
  index.unsafeKeys?.clear();
  index.unsafeCounts?.clear();
  index.magnitudes?.clear();
  index.sorted?.clear();
  for (const [storageKey, node] of Object.entries(nodes)) indexNode(index, storageKey, node);
}

function candidateIds(index, nodes, vector, workspaceId = 'default') {
  const scope = normalizeWorkspaceId(workspaceId);
  if (index.unsafeWorkspaces.has(scope) || !isSafeVector(vector)) return null;
  const workspace = index.buckets.get(scope);
  if (!workspace) return [];
  const keys = new Set();
  for (const [dimension, value] of Object.entries(vector)) {
    if (value === 0) continue;
    for (const key of workspace.get(dimension) || []) keys.add(key);
  }
  return [...keys].map((key) => nodes[key]?.id).filter(Boolean);
}

/** Bucket members of one dimension as [storageKey, value / |vector|], largest first. */
function sortedDimension(index, nodes, workspaceId, dimension) {
  if (!index.sorted.has(workspaceId)) index.sorted.set(workspaceId, new Map());
  const cache = index.sorted.get(workspaceId);
  if (!cache.has(dimension)) {
    const entries = [];
    for (const key of index.buckets.get(workspaceId)?.get(dimension) || []) {
      entries.push([key, nodes[key].vector[dimension] / index.magnitudes.get(key)]);
    }
    cache.set(dimension, entries.sort((a, b) => b[1] - a[1]));
  }
  return cache.get(dimension);
}

module.exports = { createVectorIndex, indexNode, deindexNode, rebuildVectorIndex, candidateIds,
  isSafeVector, sortedDimension };
