'use strict';

const { normalizeWorkspaceId, cloneNodeRecord, frozenNodeView } = require('./graph-record-utils');
const { applyReadBounds, normalizeReadBounds } = require('./graph-read-bounds');

function query(nodes, label, workspaceId = 'default', options = {}) {
  const { scope, limit, offset, clone } = normalizeReadBounds(workspaceId, options);
  const project = clone ? cloneNodeRecord : frozenNodeView;
  const matched = Object.values(nodes)
    .filter(node => node.label === label && normalizeWorkspaceId(node.workspaceId) === scope);
  return applyReadBounds(matched, { limit, offset }).map(project);
}

module.exports = { query };
