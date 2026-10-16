'use strict';

/**
 * knowledge-freshness (#213).
 *
 * #213 asks for a beforeAsk hook that "marks stale/old claims (by
 * timestamp)". Taken literally that's not achievable: beforeAsk's payload
 * is only { question } (see lib/kernel-read-use-cases.js), and ask()'s
 * subject-resolution logic (ozneBul, stemming, etc.) is internal to that
 * module -- a beforeAsk plugin has no visibility into which nodes/edges
 * will actually back the answer, so it cannot mark "the claims used in
 * this answer" from beforeAsk alone. And even if it could mutate
 * something there, ask() only reads `.question` back off beforeAsk's
 * result -- nothing else survives into the answer.
 *
 * What IS buildable: beforeAsk does its own light-weight, best-effort
 * lookup (normalize each question word, check if it names a graph node,
 * inspect that node's edges' timestamps) and stashes what it finds on
 * kernel state; afterAsk (which DOES receive `answer` and, since #346,
 * can actually change what the caller sees) appends a staleness notice
 * when the lookup found anything. Both hooks are needed for this to be
 * observable at all -- afterAsk alone would have no idea the answer
 * relied on old data, and beforeAsk alone has no way to tell the caller.
 *
 * This is a best-effort approximation of ask()'s own subject resolution,
 * not a reimplementation of it -- it will miss questions ask() resolves
 * through indirect subject detection (kokeIndirge, adjective phrases,
 * etc.), and that's an accepted, documented limitation rather than a bug
 * to chase, since duplicating that logic exactly would mean forking a
 * meaningful chunk of kernel-read-use-cases.js into a plugin.
 */

const DEFAULT_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function ensureFreshnessState(kernel) {
  if (!kernel._knowledgeFreshnessState) {
    kernel._knowledgeFreshnessState = { pendingStaleEdges: null };
  }
  return kernel._knowledgeFreshnessState;
}

// graph.js's real edge shape is snake_case (updated_at/created_at, plus a
// numeric epoch-ms `created`) -- camelCase createdAt/updatedAt never exist on
// a real edge record. updated_at is checked first: a REAFFIRMED edge advances
// updated_at but not created_at, and "N days since update" is what a
// freshness notice is meant to measure (#1278).
function edgeTimestamp(edge) {
  const iso = edge.updated_at || edge.created_at;
  if (typeof iso === 'string' && iso) return Date.parse(iso);
  if (Number.isFinite(edge.created)) return edge.created;
  return NaN;
}

function isStaleTimestamp(ts, staleAfterMs, now) {
  if (!ts) return false; // no timestamp recorded -- nothing to judge staleness against
  const parsed = Date.parse(ts);
  if (!Number.isFinite(parsed)) return false;
  return (now - parsed) > staleAfterMs;
}

function isStaleInstant(instant, staleAfterMs, now) {
  return Number.isFinite(instant) && (now - instant) > staleAfterMs;
}

function findStaleEdgesForQuestion(kernel, question, opts = {}) {
  const staleAfterMs = Number.isFinite(opts.staleAfterMs) ? opts.staleAfterMs : DEFAULT_STALE_AFTER_MS;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const workspaceId = opts.workspaceId || 'default';
  const graph = kernel && kernel.graph;
  if (!graph || typeof graph.getNode !== 'function' || typeof graph.getEdges !== 'function') return [];

  const words = String(question || '').toLowerCase().split(/\s+/).filter(Boolean);
  const seenWords = new Set();
  const staleEdges = [];

  for (const word of words) {
    const normalized = typeof kernel.normalizeWord === 'function' ? kernel.normalizeWord(word) : word;
    if (!normalized || seenWords.has(normalized)) continue;
    seenWords.add(normalized);
    if (!graph.getNode(normalized, workspaceId)) continue;

    for (const edge of graph.getEdges(normalized, workspaceId)) {
      const instant = edgeTimestamp(edge);
      if (isStaleInstant(instant, staleAfterMs, now)) {
        staleEdges.push({ from: edge.from, to: edge.to, relation: edge.relation, timestamp: new Date(instant).toISOString() });
      }
    }
  }
  return staleEdges;
}

module.exports = {
  name: 'knowledge-freshness',
  requires: [],
  optional: [],

  beforeAsk(kernel, data) {
    const state = ensureFreshnessState(kernel);
    state.pendingStaleEdges = findStaleEdgesForQuestion(kernel, data && data.question, {
      workspaceId: data && data.workspaceId,
    });
    return data;
  },

  afterAsk(kernel, data) {
    const state = ensureFreshnessState(kernel);
    const staleEdges = state.pendingStaleEdges;
    state.pendingStaleEdges = null; // consume once, regardless of outcome below

    // A freshness note only makes sense on an answer that exists. `unknown` is
    // the structural way to ask that; the string match stays as the fallback
    // for a payload that predates the flag.
    const answered = data && typeof data.answer === 'string'
      && (typeof data.unknown === 'boolean' ? !data.unknown : data.answer !== 'Bilmiyorum');

    if (Array.isArray(staleEdges) && staleEdges.length > 0 && answered) {
      data.answer = `${data.answer} [freshness: ${staleEdges.length} ilişki 30+ gündür güncellenmemiş]`;
    }
    return data;
  },
};

module.exports._test = {
  ensureFreshnessState,
  isStaleTimestamp,
  edgeTimestamp,
  findStaleEdgesForQuestion,
  DEFAULT_STALE_AFTER_MS,
};
