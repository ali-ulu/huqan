'use strict';

const {
  cloneNodeRecord,
  frozenNodeView,
  nodeStorageKey,
  normalizeWorkspaceId,
  ownNode,
} = require('./graph-record-utils');
const { applyReadBounds, normalizeReadBounds } = require('./graph-read-bounds');

function workspaceIdFromArgument(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value.workspaceId : value;
}

function getNodes(nodes, workspaceId = 'default', options = {}, resolveKeys = null) {
  // Graph (#3009) passes the label index's key resolver as the 4th argument so
  // a workspace read visits only that workspace's storage keys. The bounds/
  // clone options live in the 3rd argument (#3012). Both are optional; without
  // the resolver the function still scans, so it stays usable on a bare map.
  const { scope, limit, offset, clone } = normalizeReadBounds(workspaceId, options);
  const project = clone ? cloneNodeRecord : frozenNodeView;
  const scoped = [];

  // Keyed by node.id, not the map's own key -- the map key is the internal
  // storage key (nodeStorageKey), which is scope-prefixed for every
  // workspace except 'default' (#1294). Consumers must see one consistent
  // key shape regardless of workspace, the same way getNode already does.
  //
  // #3009: when the caller supplies a key resolver (the label index's workspace
  // keys), only that workspace's storage keys are visited instead of every
  // node. Without it the function still scans, so it stays usable on a bare
  // node map.
  const scopedKeys = resolveKeys ? resolveKeys(scope) : null;
  // Object.entries() already yields own keys only. The resolver's keys come from
  // the same map's index, but it is a caller-supplied function, so its lookup is
  // own-property too (#4246): a key naming something on Object.prototype must
  // not resolve an inherited value as a node.
  const entries = scopedKeys
    ? scopedKeys.map(storageKey => [storageKey, ownNode(nodes, storageKey)])
    : Object.entries(nodes);
  for (const [storageKey, node] of entries) {
    if (!node) continue;
    if (normalizeWorkspaceId(node.workspaceId) === scope) {
      scoped.push(node);
    }
  }
  const scopedNodes = {};
  for (const node of applyReadBounds(scoped, { limit, offset })) {
    // #4223: defineProperty, not `scopedNodes[node.id] = ...`. A node id of
    // `__proto__` would otherwise set this result object's prototype instead of
    // adding the entry, dropping the node from the projection. The map keeps
    // its plain prototype so consumers can still deep-compare it with `{}`.
    Object.defineProperty(scopedNodes, node.id, {
      value: project(node), enumerable: true, writable: true, configurable: true,
    });
  }
  return scopedNodes;
}

function getNode(nodes, id, workspaceId = 'default', options = {}) {
  const { scope, clone } = normalizeReadBounds(workspaceId, options);
  const storageKey = nodeStorageKey(id, scope);
  // #4223/#4246: own-property only, so a name inherited from Object.prototype
  // (`toString`/`valueOf`/`constructor`) can never resolve as a node, even when
  // the caller handed in a bare plain map instead of createNodeMap()'s
  // prototype-less one. Without this, a graph that never admitted the subject
  // answered `verified` for a claim about it instead of `unknown`.
  const node = ownNode(nodes, storageKey) || (scope === 'default' ? ownNode(nodes, id) : null);
  if (!node || normalizeWorkspaceId(node.workspaceId) !== scope) return null;
  return clone ? cloneNodeRecord(node) : frozenNodeView(node);
}

module.exports = {
  getNode,
  getNodes,
};