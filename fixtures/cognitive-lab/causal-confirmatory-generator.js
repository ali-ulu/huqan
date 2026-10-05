'use strict';

// Seeded, stratified draws: each state stratum has equal mass. Within each
// stratum nuisance values and case order are drawn independently of outcomes.
// This generator produces inputs only, never outcome labels or model outputs.
function generate(seed = 3468) {
  let randomState = seed >>> 0;
  const random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState / 4294967296; };
  function cases(prefix, count, start) {
    const entries = Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${seed}-${i}`,
      preState: { door: false, energized: i % 4 < 2, jammed: i % 2 === 0, nuisance: start + Math.floor(random() * 100000) },
      action: { name: 'unlock', args: {}, cost: 2 } }));
    for (let i = entries.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [entries[i], entries[j]] = [entries[j], entries[i]];
    }
    return entries;
  }
  return { train: cases('train', 48, 0), splits: [{ name: 'holdout', cases: cases('holdout', 160, 100000) }, { name: 'transfer', cases: cases('transfer', 160, 1000000) }] };
}
module.exports = { generate };
