'use strict';

function runSelfLearn(detectGaps) {
  const gaps = detectGaps();
  if (gaps.length === 0) return { gaps: 0, learned: 0, stub: true, message: 'Boşluk yok' };

  // Gap discovery is intentionally read-only until a governed learning/admission
  // path is supplied. Do not report unrelated edge-count changes as learning.
  return { gaps: gaps.length, learned: 0, stub: true };
}

module.exports = { runSelfLearn };
