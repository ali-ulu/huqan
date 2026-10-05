'use strict';

// Retrieval experiment on a frozen corpus (#3462, roadmap R07).
//
// Compares the baseline and candidate strategies of
// benchmarks/retrieval-experiment-strategies.js on a hash-pinned corpus of
// memories, queries and relevance judgements, and reports:
//
//   precision@k / recall@k - macro-averaged over queries; precision is
//                            hits / k (TREC convention), so returning fewer
//                            than k results is not rewarded.
//   budget                 - top-k packed in rank order into `budgetChars` of
//                            content; recall of what fits. NOT_MEASURED
//                            without a budget.
//   latency                - median / p95 per strategy. NOT_MEASURED without
//                            an injected clock, so a pure run never reports
//                            a timing it did not take. Advisory, never a gate.
//   explain                - per-hit score breakdown; opt-in, absent by default.
//
// The seed only orders the timed samples (query order and which strategy runs
// first), so quality metrics are identical for every seed. A strategy that
// returns a memory outside the corpus's active workspace records fails the
// whole run closed instead of being scored.
const crypto = require('node:crypto');
const fs = require('node:fs');
const MemoryStore = require('../lib/memory-store');
const { createPairedSampler } = require('../lib/cognitive-lab-paired-delta');
const { STRATEGIES, contentText } = require('./retrieval-experiment-strategies');

const SCHEMA = 'huqan.retrieval-experiment.v1';
const DEFAULTS = Object.freeze({ k: 5, seed: 3462, repetitions: 1, explain: false });
const METRIC_DECIMALS = 4;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function corpusHash(corpus) {
  const { workspaceId, records, queries } = corpus;
  return crypto.createHash('sha256').update(canonicalJson({ workspaceId, records, queries })).digest('hex');
}

function verifyFrozenCorpus(corpus) {
  const pinned = corpus && corpus.frozen && corpus.frozen.sha256;
  const actual = corpusHash(corpus || {});
  if (pinned !== actual) throw new Error(`frozen corpus hash mismatch: pinned ${pinned}, actual ${actual}`);
  return corpus;
}

function loadFrozenCorpus(filePath) {
  return verifyFrozenCorpus(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

function normalizeOptions(opts = {}) {
  const merged = { ...DEFAULTS, strategies: STRATEGIES, ...opts };
  for (const key of ['k', 'repetitions']) {
    if (!Number.isInteger(merged[key]) || merged[key] < 1) throw new Error(`${key} must be a positive integer`);
  }
  if (!Number.isInteger(merged.seed) || merged.seed < 0) throw new Error('seed must be a non-negative integer');
  if (merged.budgetChars !== undefined && (!Number.isInteger(merged.budgetChars) || merged.budgetChars < 1)) {
    throw new Error('budgetChars must be a positive integer');
  }
  if (merged.clock !== undefined && typeof merged.clock !== 'function') throw new Error('clock must be a function');
  return merged;
}

function seedStore(corpus) {
  const store = new MemoryStore({ useSQLite: false });
  for (const record of corpus.records) {
    store._memories.set(store.makeMemoryKey(record.workspaceId, record.memoryId), structuredClone(record));
  }
  return store;
}

function round(value) {
  return Number(value.toFixed(METRIC_DECIMALS));
}

function mean(values) {
  return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
}

function packBudget(hits, budgetChars) {
  const packed = [];
  let used = 0;
  for (const hit of hits) {
    const size = contentText(hit.record).length;
    if (used + size > budgetChars) break;
    packed.push(hit);
    used += size;
  }
  return { packed, used };
}

// A hit is scored only if it is an active record of the corpus workspace and
// appears once: a repeated id would count one relevant memory several times.
function assertValidHits(hits, scope, strategyName, queryId) {
  const seen = new Set();
  for (const { record } of hits) {
    const inScope = scope.allowedIds.has(record.memoryId)
      && record.workspaceId === scope.workspaceId && record.status === 'active';
    if (!inScope) throw new Error(`${strategyName} returned out-of-scope memory ${record.memoryId} for ${queryId}`);
    if (seen.has(record.memoryId)) throw new Error(`${strategyName} returned memory ${record.memoryId} twice for ${queryId}`);
    seen.add(record.memoryId);
  }
}

function scoreStrategy(store, corpus, strategy, options, allowedIds) {
  const scope = { allowedIds, workspaceId: corpus.workspaceId };
  const perQuery = corpus.queries.map((query) => {
    const hits = strategy.retrieve(store, corpus.workspaceId, query.text);
    assertValidHits(hits, scope, strategy.name, query.id);
    const top = hits.slice(0, options.k);
    const relevant = new Set(query.relevant);
    const hitCount = (list) => list.filter((hit) => relevant.has(hit.record.memoryId)).length;
    const row = { id: query.id, precision: hitCount(top) / options.k, recall: hitCount(top) / relevant.size, top };
    if (options.budgetChars !== undefined) {
      const { packed, used } = packBudget(top, options.budgetChars);
      row.budget = { usedChars: used, recall: hitCount(packed) / relevant.size, overBudget: packed.length < top.length };
    }
    return row;
  });
  const summary = {
    strategy: strategy.name,
    precisionAtK: mean(perQuery.map((row) => row.precision)),
    recallAtK: mean(perQuery.map((row) => row.recall)),
    budget: options.budgetChars === undefined ? 'NOT_MEASURED' : {
      budgetChars: options.budgetChars,
      meanUsedChars: mean(perQuery.map((row) => row.budget.usedChars)),
      recallWithinBudget: mean(perQuery.map((row) => row.budget.recall)),
      overBudgetQueries: perQuery.filter((row) => row.budget.overBudget).length,
    },
  };
  return { summary, perQuery };
}

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

function measureLatency(store, corpus, options) {
  if (!options.clock) return { baseline: 'NOT_MEASURED', candidate: 'NOT_MEASURED' };
  const random = createPairedSampler(options.seed);
  const samples = { baseline: [], candidate: [] };
  for (let rep = 0; rep < options.repetitions; rep++) {
    const order = corpus.queries.map((query) => ({ query, key: random() })).sort((a, b) => a.key - b.key);
    for (const { query } of order) {
      const sides = random() < 0.5 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
      for (const side of sides) {
        const start = options.clock();
        options.strategies[side].retrieve(store, corpus.workspaceId, query.text);
        samples[side].push(options.clock() - start);
      }
    }
  }
  const summarize = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return { samples: sorted.length, medianMs: round(percentile(sorted, 0.5)), p95Ms: round(percentile(sorted, 0.95)) };
  };
  return { baseline: summarize(samples.baseline), candidate: summarize(samples.candidate) };
}

function compareMetric(baseline, candidate) {
  const delta = round(candidate - baseline);
  return { baseline, candidate, delta, status: delta > 0 ? 'IMPROVED' : delta < 0 ? 'REGRESSION' : 'UNCHANGED' };
}

function compare(baseline, candidate, latency) {
  const budgetMeasured = baseline.budget !== 'NOT_MEASURED';
  return {
    precisionAtK: compareMetric(baseline.precisionAtK, candidate.precisionAtK),
    recallAtK: compareMetric(baseline.recallAtK, candidate.recallAtK),
    recallWithinBudget: budgetMeasured
      ? compareMetric(baseline.budget.recallWithinBudget, candidate.budget.recallWithinBudget) : 'NOT_MEASURED',
    latency: latency.baseline === 'NOT_MEASURED' ? 'NOT_MEASURED' : {
      baselineMedianMs: latency.baseline.medianMs,
      candidateMedianMs: latency.candidate.medianMs,
      status: 'ADVISORY',
    },
  };
}

function explainOf(perQuery) {
  return Object.fromEntries(perQuery.map((row) => [row.id,
    row.top.map((hit) => ({ memoryId: hit.record.memoryId, ...hit.explain }))]));
}

function runExperiment(corpus, opts = {}) {
  verifyFrozenCorpus(corpus);
  const options = normalizeOptions(opts);
  const store = seedStore(corpus);
  const allowedIds = new Set(corpus.records
    .filter((record) => record.workspaceId === corpus.workspaceId && record.status === 'active')
    .map((record) => record.memoryId));
  const baseline = scoreStrategy(store, corpus, options.strategies.baseline, options, allowedIds);
  const candidate = scoreStrategy(store, corpus, options.strategies.candidate, options, allowedIds);
  const latency = measureLatency(store, corpus, options);
  const report = {
    schema: SCHEMA,
    scope: 'experiment-only',
    corpus: { sha256: corpus.frozen.sha256, records: corpus.records.length, queries: corpus.queries.length },
    k: options.k,
    seed: options.seed,
    baseline: { ...baseline.summary, latency: latency.baseline },
    candidate: { ...candidate.summary, latency: latency.candidate },
    comparison: compare(baseline.summary, candidate.summary, latency),
  };
  if (options.explain === true) {
    report.explain = { baseline: explainOf(baseline.perQuery), candidate: explainOf(candidate.perQuery) };
  }
  return report;
}

module.exports = { SCHEMA, corpusHash, loadFrozenCorpus, runExperiment, verifyFrozenCorpus };
