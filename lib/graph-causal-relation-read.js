'use strict';

function isCausalRelation(causalRelations, relation) {
  return causalRelations.includes(relation);
}

function getCausalRelations(causalRelations) {
  return [...causalRelations];
}

function getCausalEdges(getEdges, causalRelations, compareCausalEdges, fromId, workspaceId = 'default') {
  const edges = getEdges(fromId, workspaceId);
  return edges
    .filter(e => isCausalRelation(causalRelations, e.relation))
    .slice()
    .sort(compareCausalEdges);
}

module.exports = { isCausalRelation, getCausalRelations, getCausalEdges };
