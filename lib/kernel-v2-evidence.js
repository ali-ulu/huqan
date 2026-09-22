'use strict';

// Extracted from kernel.v2.js by #2138. Pure evidence-shaping helpers for the
// verify/reason path: predicate normalization plus path-evidence formatting,
// confidence aggregation and summarization. No kernel/graph receiver, no
// behaviour decision — every line is verbatim from the moved methods.

const { stripCopulaOrKeep } = require('./turkish-copula');
const { normalizeAscii } = require('./kernel-v2-native');

// Guarded: bare spelling collapsed `kültür` onto `kül`, verifying a false claim at 0.95 (#1167).
function normalizeCopulaTail(predicate) {
  return stripCopulaOrKeep(String(predicate || '')).trim();
}

function normalizePredicateToken(predicate) {
  return normalizeAscii(normalizeCopulaTail(predicate));
}

function toPathEvidence(chain) {
  return chain.map(e => ({
    kind: 'path',
    text: `${e.from} --[${e.relation}]--> ${e.to}`,
    confidence: Math.max(0.4, Math.min(0.9, e.weight || 0.5)),
    nodes: [e.from, e.to],
    edges: [{ from: e.from, to: e.to, relation: e.relation }],
  }));
}

function aggregatePathConfidence(chain) {
  if (!Array.isArray(chain) || chain.length === 0) return 0.5;
  let total = 0;
  for (const edge of chain) {
    total += Math.max(0.4, Math.min(0.9, edge.weight || 0.5));
  }
  const avg = total / chain.length;
  return Number(Math.max(0.4, Math.min(0.9, avg)).toFixed(2));
}

function buildReasoningPath(chain) {
  return chain.map(edge => ({
    from: edge.from,
    relation: edge.relation,
    to: edge.to,
  }));
}

function summarizeEvidence(evidence = [], reasoningPath = []) {
  const summary = [];
  for (const item of Array.isArray(evidence) ? evidence : []) {
    if (!item || typeof item.text !== 'string') continue;
    if (!summary.includes(item.text)) summary.push(item.text);
    if (summary.length >= 4) break;
  }

  if (summary.length === 0 && Array.isArray(reasoningPath) && reasoningPath.length > 0) {
    for (const step of reasoningPath) {
      if (!step || !step.from || !step.relation || !step.to) continue;
      const text = `${step.from} --[${step.relation}]--> ${step.to}`;
      if (!summary.includes(text)) summary.push(text);
      if (summary.length >= 4) break;
    }
  }

  return summary;
}

module.exports = {
  normalizeCopulaTail,
  normalizePredicateToken,
  toPathEvidence,
  aggregatePathConfidence,
  buildReasoningPath,
  summarizeEvidence,
};
