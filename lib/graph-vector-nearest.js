'use strict';

// #3017 follow-up: exact top-1 cosine over the dimension index. The bucket
// candidates alone degrade to every node once a common tag is shared, so this
// walks each query dimension's list largest-normalized-weight first and stops
// once no unread node can still reach the best score (Fagin's threshold
// algorithm). The answer is the one an exhaustive scan gives, ties included:
// the caller's rank decides between equal scores, as its scan order did.

const { normalizeWorkspaceId } = require('./graph-record-utils');
const { isSafeVector, sortedDimension } = require('./graph-vector-index');

// The bound sums normalized weights while scores come from cosineSimilarity;
// the margin keeps float rounding from stopping one entry too early.
const STOP_MARGIN = 1e-9;

/** Unit query weights, or null when a negative weight breaks the bound. */
function queryWeights(vector) {
  if (!isSafeVector(vector)) return null;
  const entries = Object.entries(vector).filter(([, value]) => value !== 0);
  if (entries.some(([, value]) => value < 0)) return null;
  const magnitude = Math.sqrt(entries.reduce((sum, [, value]) => sum + value * value, 0));
  return entries.map(([dimension, value]) => [dimension, value / magnitude]);
}

/** The list with the largest remaining bound, plus the bound summed over all lists. */
function nextStep(lists) {
  let best = null, threshold = 0;
  for (const list of lists) {
    if (list.at >= list.entries.length) continue;
    const bound = list.weight * Math.max(list.entries[list.at][1], 0);
    threshold += bound;
    if (!best || bound > best.bound) best = { list, bound };
  }
  return { list: best?.list || null, threshold };
}

/**
 * @param {object} index - graph vector index
 * @param {object} nodes - storageKey -> node
 * @param {object} vector - query vector
 * @param {string} workspaceId
 * @param {{ isEligible: Function, rank: Function, score: Function }} opts -
 *   `score(id)` returns the similarity, or null to abort (budget exhausted).
 * @returns {{ id: string|null, similarity: number, aborted: boolean }|null}
 *   null when the index cannot bound this query; the caller then scans.
 */
function nearestSimilar(index, nodes, vector, workspaceId, opts) {
  const scope = normalizeWorkspaceId(workspaceId);
  if (index.unsafeWorkspaces.has(scope)) return null;
  const weights = queryWeights(vector);
  if (!weights) return null;
  const lists = weights.map(([dimension, weight]) =>
    ({ weight, entries: sortedDimension(index, nodes, scope, dimension), at: 0 }));
  const seen = new Set();
  let best = null, bestSimilarity = 0;
  for (;;) {
    const { list, threshold } = nextStep(lists);
    if (!list || threshold <= 0 || threshold + STOP_MARGIN < bestSimilarity) break;
    const key = list.entries[list.at++][0];
    if (seen.has(key)) continue;
    seen.add(key);
    const id = nodes[key]?.id;
    if (!id || !opts.isEligible(id)) continue;
    const similarity = opts.score(id);
    if (similarity === null) return { id: best, similarity: bestSimilarity, aborted: true };
    if (similarity > bestSimilarity ||
        (similarity === bestSimilarity && best !== null && opts.rank(id) < opts.rank(best))) {
      best = id;
      bestSimilarity = similarity;
    }
  }
  return { id: best, similarity: bestSimilarity, aborted: false };
}

module.exports = { nearestSimilar };
