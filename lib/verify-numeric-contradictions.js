'use strict';

const { temporalQualifier } = require('./temporal-qualifier');

/**
 * The `sayısal` contradiction pass, extracted from lib/verify.js (#1186).
 *
 * The rule: two edges of the same node whose targets carry different numbers
 * but the same surrounding text describe the same measurement twice, so they
 * contradict. Two guards keep it from firing on unrelated pairs -- the shared
 * text core must be at least 5 characters, and both targets must carry the
 * same temporal qualifier, since differing dates describe a series rather than
 * one measurement (#1175).
 *
 * It used to evaluate those guards *inside* the pair loop, recomputing the
 * text core, its whitespace normalisation and the qualifier for every one of a
 * node's d²/2 pairs. Measured on a hub with numeric neighbour labels and
 * nothing else in the graph, detectContradictions() took 12 s at degree 1600
 * and returned zero contradictions -- every pair failed the 5-character guard
 * after the string work had already been done.
 *
 * Both guards are properties of a single edge, not of a pair:
 *
 *   - an edge whose own core is shorter than 5 characters can never be the
 *     shorter side of a matching pair, so it cannot match anything;
 *   - an edge can only pair with edges carrying its own qualifier.
 *
 * So each edge is measured once, unmatchable edges never enter the loop, and
 * the rest are compared within their qualifier group. Which pairs fire is
 * unchanged, and so is emission order: i ascends over the surviving edges and
 * j ascends within i's group.
 *
 * What this does not change: a node whose neighbours genuinely share a text
 * core still produces a contradiction per pair, which is quadratic in the
 * *output* rather than in wasted work. Bounding that means capping results,
 * which is a change to what the function answers, not to how fast it answers.
 */

/** Cores shorter than this can never satisfy the pair guard. */
const MIN_SHARED_CORE_LENGTH = 5;

/**
 * @param {object[]} edges - the node's edges
 * @param {string} nodeId
 * @param {object} text - { extractNumbers, getTextCore } bound by the caller
 * @returns {object[]} contradictions, in the same order the pairwise scan emitted
 */
function findNumericContradictions(edges, nodeId, text) {
  const candidates = [];
  for (const edge of edges) {
    if (edge.relation === 'hipotez') continue;
    const nums = text.extractNumbers(edge.to);
    if (!nums) continue;
    const norm = text.getTextCore(edge.to).replace(/\s+/g, ' ');
    if (norm.length < MIN_SHARED_CORE_LENGTH) continue;
    candidates.push({ edge, nums, norm, qualifier: temporalQualifier(edge.to) });
  }
  if (candidates.length < 2) return [];

  const byQualifier = new Map();
  for (let index = 0; index < candidates.length; index += 1) {
    const bucket = byQualifier.get(candidates[index].qualifier);
    if (bucket) bucket.push(index);
    else byQualifier.set(candidates[index].qualifier, [index]);
  }

  const contradictions = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const left = candidates[i];
    for (const j of byQualifier.get(left.qualifier)) {
      if (j <= i) continue;
      const right = candidates[j];
      if (left.nums === right.nums) continue;
      const shorter = left.norm.length <= right.norm.length ? left.norm : right.norm;
      const longer = left.norm.length <= right.norm.length ? right.norm : left.norm;
      if (!longer.includes(shorter)) continue;
      contradictions.push({
        type: 'sayısal',
        node: nodeId,
        targets: [left.edge.to, right.edge.to],
        confidence: 0.75,
        message: 'numeric conflict for ' + nodeId,
        edges: [left.edge, right.edge],
      });
    }
  }
  return contradictions;
}

module.exports = { findNumericContradictions, MIN_SHARED_CORE_LENGTH };
