'use strict';

// Retrieval strategies compared by benchmarks/retrieval-experiment.js (#3462).
//
// Both strategies read through the real MemoryStore.query path, so the
// workspace boundary and the active-status filter are the store's own, not a
// re-implementation. Neither strategy is wired into the product: the candidate
// exists only inside this experiment until a measured result argues for it.
//
//   baseline  - what huqan does today: `query({ text })`, a case-insensitive
//               substring match on the whole query, ordered by createdAt.
//   candidate - BM25 over word tokens of the same active records, ties broken
//               by memoryId so the order is deterministic.
const { normalizeText } = require('../lib/text-utils');

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const SCORE_DECIMALS = 6;

function round(value) {
  return Number(value.toFixed(SCORE_DECIMALS));
}

function contentText(record) {
  return typeof record.content === 'string' ? record.content : JSON.stringify(record.content);
}

function tokenize(text) {
  return normalizeText(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function baselineRetrieve(store, workspaceId, queryText) {
  const result = store.query({ workspaceId, text: queryText, limit: null });
  if (!result.ok) throw new Error(`baseline query failed: ${result.error.message}`);
  return result.memories.map((record) => ({ record, explain: { matched: 'substring' } }));
}

function buildIndex(records) {
  const docs = records.map((record) => {
    const tokens = tokenize(contentText(record));
    const tf = new Map();
    for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1);
    return { record, length: tokens.length, tf };
  });
  const df = new Map();
  for (const doc of docs) for (const term of doc.tf.keys()) df.set(term, (df.get(term) || 0) + 1);
  const avgLength = docs.length ? docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length : 0;
  return { docs, df, avgLength };
}

function idf(index, term) {
  const n = index.docs.length;
  const df = index.df.get(term) || 0;
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

function scoreDoc(index, doc, terms) {
  const contributions = [];
  for (const term of terms) {
    const tf = doc.tf.get(term) || 0;
    if (tf === 0) continue;
    const termIdf = idf(index, term);
    const norm = tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / (index.avgLength || 1)));
    contributions.push({ term, tf, idf: round(termIdf), contribution: round(termIdf * (tf * (BM25_K1 + 1)) / norm) });
  }
  const score = round(contributions.reduce((sum, entry) => sum + entry.contribution, 0));
  return { score, terms: contributions };
}

function candidateRetrieve(store, workspaceId, queryText) {
  const result = store.query({ workspaceId, limit: null });
  if (!result.ok) throw new Error(`candidate query failed: ${result.error.message}`);
  const index = buildIndex(result.memories);
  const terms = [...new Set(tokenize(queryText))];
  return index.docs
    .map((doc) => ({ record: doc.record, explain: scoreDoc(index, doc, terms) }))
    .filter((hit) => hit.explain.score > 0)
    .sort((a, b) => (b.explain.score - a.explain.score) || a.record.memoryId.localeCompare(b.record.memoryId));
}

const STRATEGIES = Object.freeze({
  baseline: Object.freeze({ name: 'substring-createdAt', retrieve: baselineRetrieve }),
  candidate: Object.freeze({ name: 'bm25-lexical', retrieve: candidateRetrieve }),
});

module.exports = { STRATEGIES, tokenize, contentText };
