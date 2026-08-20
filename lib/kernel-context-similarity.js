function runContextSimilarity(graph, a, b, context) {
  const ctxWeight = {};
  const ctxNode = graph.getNode(context);
  if (ctxNode) {
    for (const [dim, w] of Object.entries(ctxNode.vector)) {
      ctxWeight[dim] = w;
    }
  }

  const aNode = graph.getNode(a);
  const bNode = graph.getNode(b);
  if (!aNode || !bNode) return 0;

  const dims = new Set([
    ...Object.keys(aNode.vector),
    ...Object.keys(bNode.vector),
    ...Object.keys(ctxWeight),
  ]);

  let dot = 0, magA = 0, magB = 0;
  for (const d of dims) {
    const cw = ctxWeight[d] || 1;
    const va = (aNode.vector[d] || 0) * cw;
    const vb = (bNode.vector[d] || 0) * cw;
    dot += va * vb;
    magA += va * va;
    magB += vb * vb;
  }

  const mag = Math.sqrt(magA) * Math.sqrt(magB);
  return mag === 0 ? 0 : dot / mag;
}

module.exports = { runContextSimilarity };
