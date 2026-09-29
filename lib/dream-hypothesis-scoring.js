'use strict';

/**
 * Node-quality gate and composite score for Dream hypotheses.
 *
 * Split out of the root `dream.js` (#2120). The functions take the graph as a
 * parameter instead of a Dream instance so this module never reaches into
 * another module's private state (docs/architecture-policy.md §4).
 */

const { normalizeWorkspaceId } = require('./graph-record-utils');

const MIN_DREAM_NODE_QUALITY = 0.3;

function measureDreamNodeQuality(value) {
  if (typeof value !== 'string') return 0;
  const text = value.normalize('NFKC').trim();
  if (!text || !/\p{L}/u.test(text)) return 0;

  // Markdown table fragments and rendered list/quote markers are document
  // structure, not concepts. A pipe anywhere in a node is especially strong
  // evidence that a table row was ingested as prose (#1643).
  if (text.includes('|') || /^(?:#{1,6}|[-*+]|>)\s+/u.test(text)) return 0;

  // Volatile CI execution identifiers create pairs that differ only by an
  // opaque number (for example "npm test job 93172327986 success"). They are
  // useful provenance, but not stable graph concepts from which to dream.
  if (/\b(?:job|run|build|workflow|check)[\s_:#-]+\d{5,}\b/iu.test(text)) return 0;

  const alphanumeric = Array.from(text).filter(char => /[\p{L}\p{N}]/u.test(char));
  const digitCount = alphanumeric.filter(char => /\p{N}/u.test(char)).length;
  const digitRatio = digitCount / Math.max(1, alphanumeric.length);
  const wordCount = text.split(/\s+/u).filter(Boolean).length;

  let quality = text.length === 1 ? 0.35 : 0.6;
  if (text.length >= 4) quality += 0.15;
  if (wordCount >= 2 && wordCount <= 8) quality += 0.1;
  if (text.length > 160) quality -= 0.2;
  if (digitRatio > 0.35) quality -= 0.25;
  return Math.max(0, Math.min(1, quality));
}

function hypothesisNodeQuality(hypothesis) {
  const values = [
    hypothesis.from,
    hypothesis.to,
    hypothesis.node,
    hypothesis.via,
    ...(Array.isArray(hypothesis.targets) ? hypothesis.targets : []),
  ].filter(value => value !== undefined && value !== null);
  if (values.length === 0) return 0;
  return Math.min(...values.map(measureDreamNodeQuality));
}

function calculateCompositeScore(graph, hyp, context = null) {
  const confidence = hyp.confidence || 0.3;
  const scope = normalizeWorkspaceId(context ? context.workspaceId : undefined);
  const quality = hypothesisNodeQuality(hyp);

  let novelty = 0;
  if (hyp.type === 'çelişki') {
    novelty = 1.0;
  } else if (hyp.from && hyp.to) {
    const exists = context
      ? context.outTargets.get(hyp.from)?.has(hyp.to)
        || context.outTargets.get(hyp.to)?.has(hyp.from)
      : graph.getEdges(hyp.from, scope).some(e => e.to === hyp.to)
        || graph.getEdges(hyp.to, scope).some(e => e.to === hyp.from);
    novelty = exists ? 0 : 1;
  }

  let usefulness = 0;
  const nodeId = hyp.from || hyp.node;
  if (nodeId) {
    const outDeg = context ? (context.outEdges.get(nodeId)?.length || 0) : graph.getEdges(nodeId, scope).length;
    const inDeg = context ? (context.inEdges.get(nodeId)?.length || 0) : graph.getInEdges(nodeId, scope).length;
    const deg = outDeg + inDeg;
    const nodes = context ? context.nodes : Object.values(graph._nodes);
    const avgDeg = context ? context.avgDeg : nodes.reduce((s, n) => {
      return s + graph.getEdges(n.id, scope).length + graph.getInEdges(n.id, scope).length;
    }, 0) / Math.max(1, nodes.length);
    usefulness = avgDeg > 0 ? Math.min(1, deg / avgDeg) : 0;
  }

  return {
    score: confidence * 0.45 + novelty * 0.25 + usefulness * 0.2 + quality * 0.1,
    confidence,
    novelty,
    usefulness,
    quality,
  };
}

module.exports = {
  MIN_DREAM_NODE_QUALITY,
  measureDreamNodeQuality,
  hypothesisNodeQuality,
  calculateCompositeScore,
};
