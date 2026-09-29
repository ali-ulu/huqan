'use strict';

const { normalizeWorkspaceId, cloneNodeRecord, frozenNodeView } = require('./graph-record-utils');
const { applyReadBounds, normalizeReadBounds } = require('./graph-read-bounds');
const { queryLabelKeys } = require('./graph-label-index');

function query(nodes, label, workspaceId = 'default', labelIndexOrOptions, options = {}) {
  // Main (#3009) passes labelIndex as 4th arg for O(1) label lookup.
  // labelIndex has a `buckets` property (Map). We detect it by checking for `buckets` property.
  // Otherwise 4th arg is options (our bounds/clone).
  let labelIndex = null;
  if (labelIndexOrOptions && typeof labelIndexOrOptions === 'object' && labelIndexOrOptions.buckets instanceof Map) {
    labelIndex = labelIndexOrOptions;
  } else {
    options = labelIndexOrOptions || {};
  }

  const { scope, limit, offset, clone } = normalizeReadBounds(workspaceId, options);
  const project = clone ? cloneNodeRecord : frozenNodeView;

  // #3009: label index returns matching storage keys directly (O(1) instead of O(N) scan)
  // If no labelIndex provided, fall back to full scan (backward compatible)
  const matched = labelIndex
    ? queryLabelKeys(labelIndex, label, scope).map(storageKey => nodes[storageKey]).filter(Boolean)
    : Object.values(nodes).filter(node => node.label === label && normalizeWorkspaceId(node.workspaceId) === scope);

  return applyReadBounds(matched, { limit, offset }).map(project);
}

module.exports = { query };