'use strict';

// #3009: the label lookup primitive used to scan every node
// (`Object.values(nodes).filter(node => node.label === label)` in
// graph-query-read.js), so a label query was O(N) in the whole node map. The
// SQLite schema already declares `idx_nodes_workspace_label`, but reads run
// against the in-memory node map, not SQLite.
//
// This module owns the in-memory index that mirrors `_nodes`:
//   - `buckets`: (workspaceId, label) -> Set of storage keys, the label lookup;
//   - `workspaces`: workspaceId -> Set of storage keys, so a workspace-scoped
//     read/count/optimize touches only its own nodes instead of every node;
//   - `owner`: storage key -> its bucket/workspace, so removal and reindex are
//     O(1) without scanning a bucket.
//
// Graph builds and maintains it the same way it maintains `_outIndex`/`_inIndex`
// for edges: incrementally on the single-record write paths and by full rebuild
// on load/restore. `_nodes` stays the single source of truth; the index is
// derived state and is always reconstructible from it, which is what makes
// rollback, reload and consolidate correct by rebuilding rather than patching.

const { normalizeWorkspaceId } = require('./workspace-id');

// JSON encoding of the [workspace, label] tuple is injective for any string
// content, so no separator character has to be assumed absent from either part.
// (A plain `${workspace}${sep}${label}` string is ambiguous: a workspace id may
// itself contain the separator, which would merge two distinct buckets.)
function labelBucketKey(workspaceId, label) {
  return JSON.stringify([normalizeWorkspaceId(workspaceId), label]);
}

function createLabelIndex() {
  return { buckets: new Map(), workspaces: new Map(), owner: new Map() };
}

function indexNode(index, storageKey, node) {
  // Reindexing a key that already has an entry drops the old membership first,
  // so a label or workspace change on an existing node cannot leave the node in
  // two buckets.
  deindexNode(index, storageKey);
  if (!node) return;
  const workspaceId = normalizeWorkspaceId(node.workspaceId);
  const bucketKey = labelBucketKey(workspaceId, node.label);
  let bucket = index.buckets.get(bucketKey);
  if (!bucket) {
    bucket = new Set();
    index.buckets.set(bucketKey, bucket);
  }
  bucket.add(storageKey);
  let workspace = index.workspaces.get(workspaceId);
  if (!workspace) {
    workspace = new Set();
    index.workspaces.set(workspaceId, workspace);
  }
  workspace.add(storageKey);
  index.owner.set(storageKey, { workspaceId, bucketKey });
}

function deindexNode(index, storageKey) {
  const entry = index.owner.get(storageKey);
  if (!entry) return false;
  index.owner.delete(storageKey);
  const bucket = index.buckets.get(entry.bucketKey);
  if (bucket) {
    bucket.delete(storageKey);
    if (bucket.size === 0) index.buckets.delete(entry.bucketKey);
  }
  const workspace = index.workspaces.get(entry.workspaceId);
  if (workspace) {
    workspace.delete(storageKey);
    if (workspace.size === 0) index.workspaces.delete(entry.workspaceId);
  }
  return true;
}

function rebuildLabelIndex(index, nodes) {
  index.buckets.clear();
  index.workspaces.clear();
  index.owner.clear();
  for (const [storageKey, node] of Object.entries(nodes)) {
    indexNode(index, storageKey, node);
  }
}

// Storage keys of the nodes in `workspaceId` whose label is `label`. The caller
// clones through `_nodes`, so callers never observe the internal storage key.
function queryLabelKeys(index, label, workspaceId = 'default') {
  const bucket = index.buckets.get(labelBucketKey(workspaceId, label));
  return bucket ? [...bucket] : [];
}

// Storage keys of every node in `workspaceId`.
function workspaceKeys(index, workspaceId = 'default') {
  const workspace = index.workspaces.get(normalizeWorkspaceId(workspaceId));
  return workspace ? [...workspace] : [];
}

// O(1) workspace node count, replacing a full scan of `_nodes` (#3009).
function workspaceNodeCount(index, workspaceId = 'default') {
  const workspace = index.workspaces.get(normalizeWorkspaceId(workspaceId));
  return workspace ? workspace.size : 0;
}

module.exports = {
  createLabelIndex,
  deindexNode,
  indexNode,
  labelBucketKey,
  queryLabelKeys,
  rebuildLabelIndex,
  workspaceKeys,
  workspaceNodeCount,
};
