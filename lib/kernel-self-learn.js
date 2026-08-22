'use strict';

function runSelfLearn(detectGaps, graph) {
  const gaps = detectGaps();
  if (gaps.length === 0) return { gaps: 0, learned: 0, message: 'Boşluk yok' };

  const before = graph.edgeCount();
  for (const gapId of gaps) {
    const node = graph.getNode(gapId);
    if (!node) continue;
    const hasAnyEdge = graph.getEdges(gapId).length > 0 || graph.getInEdges(gapId).length > 0;
    if (hasAnyEdge) continue;

    const sim = graph.cosineSimilarity ? graph.cosineSimilarity(gapId, gapId) : 0;
  }

  const after = graph.edgeCount();
  return { gaps: gaps.length, learned: after - before };
}

module.exports = { runSelfLearn };
