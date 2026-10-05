'use strict';

// BM25 relevance ranking for memory search (#3462 follow-up).
//
// Opt-in through MemoryStore.query({ text, retrievalMode: 'bm25' }); the
// default substring path never reaches this module. It was measured before it
// was wired: benchmarks/retrieval-experiment.js on 409 issue-title queries over
// 1000 huqan PRs took recall@10 from 0.037 (whole-query substring) to 0.842.
//
// Term statistics come from the records the caller's filters admitted, so the
// ranking is scoped exactly like the result set. Scores are rounded so the
// order is identical on every platform, and ties fall back to memoryId.
const { normalizeText } = require('./text-utils');
const { toStableString } = require('./memory-store-utils');

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const SCORE_DECIMALS = 6;

function round(value) {
  return Number(value.toFixed(SCORE_DECIMALS));
}

function tokenize(text) {
  return normalizeText(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function recordText(record) {
  return typeof record.content === 'string' ? record.content : toStableString(record.content);
}

// Tokenizing every record on every search dominated the cost (~68 ms per
// query at 1000 records). A term vector is a pure function of the text, so it
// is cached by the text itself: an edited record has different text and can
// never hit a stale entry. Bounded by count and by text length, FIFO eviction.
const TERM_CACHE_LIMIT = 5000;
const TERM_CACHE_MAX_TEXT = 4096;
const termCache = new Map();

function termVector(text) {
  const cached = termCache.get(text);
  if (cached) return cached;
  const tokens = tokenize(text);
  const tf = new Map();
  for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1);
  const vector = { length: tokens.length, tf };
  if (text.length <= TERM_CACHE_MAX_TEXT) {
    if (termCache.size >= TERM_CACHE_LIMIT) termCache.delete(termCache.keys().next().value);
    termCache.set(text, vector);
  }
  return vector;
}

// Document frequency is needed only for the query's own terms.
function buildIndex(records, terms) {
  const docs = records.map((record) => ({ record, ...termVector(recordText(record)) }));
  const df = new Map(terms.map((term) => [term, docs.filter((doc) => doc.tf.has(term)).length]));
  const avgLength = docs.length ? docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length : 0;
  return { docs, df, avgLength };
}

function scoreDoc(index, doc, terms) {
  const contributions = [];
  for (const term of terms) {
    const tf = doc.tf.get(term) || 0;
    if (tf === 0) continue;
    const df = index.df.get(term) || 0;
    const idf = Math.log(1 + (index.docs.length - df + 0.5) / (df + 0.5));
    const norm = tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / (index.avgLength || 1)));
    contributions.push({ term, tf, idf: round(idf), contribution: round(idf * (tf * (BM25_K1 + 1)) / norm) });
  }
  return { score: round(contributions.reduce((sum, entry) => sum + entry.contribution, 0)), terms: contributions };
}

/**
 * Rank records by BM25 relevance to `queryText`. Records sharing no term with
 * the query are dropped, like a substring miss.
 * @param {object[]} records - already filtered; read-only
 * @param {string} queryText
 * @returns {{ record: object, score: number, terms: object[] }[]} best first
 */
function rankByBm25(records, queryText) {
  const terms = [...new Set(tokenize(queryText))];
  const index = buildIndex(records, terms);
  return index.docs
    .map((doc) => ({ record: doc.record, ...scoreDoc(index, doc, terms) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => (b.score - a.score) || a.record.memoryId.localeCompare(b.record.memoryId));
}

module.exports = { rankByBm25 };
