'use strict';

function getWeight(getNode, decayLambda, id, workspaceId = 'default') {
  const node = getNode(id, workspaceId);
  if (!node) return 0;
  const elapsed = (Date.now() - node.lastAccessed) / 1000;
  const decayed = node.weight * Math.exp(-decayLambda * elapsed);
  return Math.max(0, Math.min(1, decayed));
}

module.exports = { getWeight };
