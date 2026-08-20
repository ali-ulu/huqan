'use strict';

function runLearnDocument(learn, text, opts = {}) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 3 && !l.startsWith('#') && !l.startsWith('//'));
  let count = 0;
  const admissions = [];
  for (const line of lines) {
    const cleaned = line.replace(/^[\s\-–—*•]+/, '').trim();
    const words = cleaned.split(/\s+/);
    if (words.length >= 2) {
      const result = learn(cleaned, opts);
      count += Number(result?.data?.learned || 0);
      if (result?.data?.admission) admissions.push(result.data.admission);
    }
  }
  if (opts.returnDetails) {
    return { learned: count, admissions };
  }
  return count;
}

module.exports = { runLearnDocument };
