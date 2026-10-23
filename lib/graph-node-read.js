'use strict';

const {
  cloneNodeRecord,
  frozenNodeView,
  nodeStorageKey,
  normalizeWorkspaceId,
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
  // Object.entries() already yields own keys only; the resolver's keys come from
  // the same map's index, so both branches stay own-property.
  const entries = scopedKeys
    ? scopedKeys.map(storageKey => [storageKey, nodes[storageKey]])
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
  // #4223: the node map is prototype-less (createNodeMap), so this read can
  // never resolve a name inherited from Object.prototype -- `nodes[storageKey]`
  // is undefined for `toString`/`valueOf` and returns the own record for
  // `__proto__`, without a per-read own-property check.
  const node = nodes[storageKey] || (scope === 'default' ? nodes[id] : null);
  if (!node || normalizeWorkspaceId(node.workspaceId) !== scope) return null;
  return clone ? cloneNodeRecord(node) : frozenNodeView(node);
}

module.exports = {
  getNode,
  getNodes,
};