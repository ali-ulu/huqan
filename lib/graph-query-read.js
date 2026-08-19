'use strict';

const { normalizeWorkspaceId, cloneNodeRecord } = require('./graph-record-utils');

function query(nodes, label, workspaceId = 'default') {
  const scope = normalizeWorkspaceId(workspaceId);
  return Object.values(nodes)
    .filter(node => node.label === label && normalizeWorkspaceId(node.workspaceId) === scope)
    .map(cloneNodeRecord);
}

module.exports = { query };
