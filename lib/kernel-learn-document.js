'use strict';

function runLearnDocument(learn, text, opts = {}, hooks = {}) {
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
  // #1747 batch persistence: with deferSave the per-learned-line save is
  // suppressed inside learn(); flush the graph exactly once per document
  // here. The flush hook is injected by the caller (Kernel.learnDocument)
  // so this module stays decoupled from the Kernel class (#328 line budget).
  if (opts.deferSave === true && typeof hooks.flushGraph === 'function') {
    try { hooks.flushGraph(); } catch (e) { console.error('[Kernel] Graph save hatası:', e.message); }
  }
  if (opts.returnDetails) {
    return { learned: count, admissions };
  }
  return count;
}

module.exports = { runLearnDocument };
