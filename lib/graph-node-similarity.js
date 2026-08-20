'use strict';

function cosineSimilarity(getNode, aId, bId, workspaceId = 'default') {
  const a = getNode(aId, workspaceId);
  const b = getNode(bId, workspaceId);
  if (!a || !b) return 0;
  const dims = new Set([...Object.keys(a.vector), ...Object.keys(b.vector)]);
  let dot = 0, magA = 0, magB = 0;
  for (const d of dims) {
    const va = a.vector[d] || 0;
    const vb = b.vector[d] || 0;
    dot += va * vb; magA += va * va; magB += vb * vb;
  }
  const mag = Math.sqrt(magA) * Math.sqrt(magB);
  return mag === 0 ? 0 : dot / mag;
}

module.exports = { cosineSimilarity };
