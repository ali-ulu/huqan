'use strict';

// Retrieval strategies compared by benchmarks/retrieval-experiment.js (#3462).
//
// Both strategies are the shipped MemoryStore.query path, so the workspace
// boundary, the active-status filter and the ranking are the store's own --
// the experiment measures exactly what callers get, not a re-implementation.
//
//   baseline  - the default: `query({ text })`, a case-insensitive substring
//               match on the whole query, ordered by createdAt.
//   candidate - the opt-in `query({ text, retrievalMode: 'bm25' })`
//               (lib/memory-query-bm25.js), ties broken by memoryId.
function contentText(record) {
  return typeof record.content === 'string' ? record.content : JSON.stringify(record.content);
}

function runStoreQuery(store, opts, label) {
  const result = store.query({ ...opts, limit: null });
  if (!result.ok) throw new Error(`${label} query failed: ${result.error.message}`);
  return result;
}

function prepareBaseline(store, workspaceId) {
  return (queryText) => runStoreQuery(store, { workspaceId, text: queryText }, 'baseline').memories
    .map((record) => ({ record, explain: { matched: 'substring' } }));
}

function prepareCandidate(store, workspaceId) {
  return (queryText) => {
    const result = runStoreQuery(store, { workspaceId, text: queryText, retrievalMode: 'bm25', explain: true }, 'candidate');
    return result.memories.map((record, i) => {
      const { score, terms } = result.retrieval.scores[i];
      return { record, explain: { score, terms } };
    });
  };
}

const STRATEGIES = Object.freeze({
  baseline: Object.freeze({ name: 'substring-createdAt', prepare: prepareBaseline }),
  candidate: Object.freeze({ name: 'bm25-lexical', prepare: prepareCandidate }),
});

module.exports = { STRATEGIES, contentText };
