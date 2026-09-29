'use strict';

const { cloneNodeRecord } = require('./graph-record-utils');
const { queryLabelKeys } = require('./graph-label-index');

// #3009: label lookup used to be `Object.values(nodes).filter(...)`, an O(N)
// scan per query. The label index (maintained by Graph, keyed by normalized
// workspace + label) returns the matching storage keys directly. `nodes` is
// still the source of truth: every key is resolved through it and cloned, so
// the result shape and defensive cloning are unchanged.
function query(nodes, label, workspaceId = 'default', labelIndex) {
  return queryLabelKeys(labelIndex, label, workspaceId)
    .map(storageKey => nodes[storageKey])
    .filter(Boolean)
    .map(cloneNodeRecord);
}

module.exports = { query };

