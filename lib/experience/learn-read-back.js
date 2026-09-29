'use strict';

/**
 * Independent verification of a `learn` step by reading the graph back
 * (#3151, owner decision 2026-09-29: "read it from the graph").
 *
 * A `learn` result says which edges it wrote (`result.evidence[].edges`). That
 * is the executor's own claim, and executor success alone never verifies
 * (`verifier.js`). This module asks the graph instead, through its read path
 * (`graph.getEdge`), whether each claimed edge is there and whether it is the
 * edge this step wrote:
 *
 * - **verification** -- every claimed edge reads back;
 * - **coverage** -- the claimed edges account for every fact the result
 *   counts as learned, so nothing written goes unchecked;
 * - **integrity** -- each edge read back carries this step's input text as
 *   its evidence, i.e. it is this write and not an older edge with the same
 *   endpoints;
 * - **provenance** -- each edge carries the provenance id the write reported;
 * - **permission** -- the write path reports the write as permitted (the
 *   admission let it into the graph, or it was a durable mutation with no
 *   admission in the way).
 *
 * ## Independence, and its limit
 *
 * The executor is `kernel.learn` through the learn use case; the channel is
 * `graph.getEdge` through the graph's read methods. Tool and adapter differ,
 * which is what `verifier.js#checkIndependence` requires. Both run in the same
 * process against the same in-memory graph, so this proves the edge is in the
 * graph the next reader sees, not that it reached the disk. A durable read-back
 * would need a second store handle, which is a larger decision than #3151.
 *
 * A missing edge is a `failed` verdict with failure evidence (which edges); a
 * result that names no edge at all is `unknown`, because there is nothing to
 * read back.
 * Anything the check cannot establish degrades to `unknown` in
 * `verifier.js`; nothing here decides the outcome status itself.
 */

const { VERIFIER_KINDS, VERDICTS } = require('./verifier');

const VERIFIER = Object.freeze({ name: 'graph-read-back', version: '1' });
const EXECUTOR = Object.freeze({ tool: 'kernel.learn', adapter: 'learn-use-case', credentials: 'in-process' });
const CHANNEL = Object.freeze({ tool: 'graph.getEdge', adapter: 'graph-read-methods', credentials: 'in-process' });
const MAX_LISTED_MISSING = 5;

function claimedEdges(result) {
  const evidence = result && Array.isArray(result.evidence) ? result.evidence : [];
  const edges = [];
  for (const item of evidence) {
    for (const edge of (item && Array.isArray(item.edges) ? item.edges : [])) {
      if (edge && typeof edge.from === 'string' && typeof edge.to === 'string' && typeof edge.relation === 'string') {
        edges.push({ from: edge.from, to: edge.to, relation: edge.relation });
      }
    }
  }
  return edges;
}

function learnedCount(result) {
  const learned = result && result.data ? result.data.learned : 0;
  return Number.isInteger(learned) && learned > 0 ? learned : 0;
}

function writePermitted(result) {
  const admission = result.data ? result.data.admission : null;
  if (admission && typeof admission === 'object') return admission.graphWrite === true;
  return Boolean(result.meta && result.meta.durableMutation === true);
}

function provenanceIdOf(result) {
  const provenance = result.meta && result.meta.provenance;
  return provenance && typeof provenance.provenanceId === 'string' ? provenance.provenanceId : null;
}

function readBack(graph, edges, workspaceId) {
  const found = [];
  const missing = [];
  for (const edge of edges) {
    let stored = null;
    try {
      stored = graph.getEdge(edge.from, edge.to, edge.relation, workspaceId);
    } catch (_) {
      stored = null;
    }
    if (stored) found.push(stored);
    else missing.push(`${edge.from}|${edge.relation}|${edge.to}`);
  }
  return { found, missing };
}

/**
 * The verifier assessment for one `learn` step, or null when the step wrote
 * nothing (nothing to verify) or the graph has no read path.
 */
function assessLearnReadBack({ graph, step, state, result } = {}) {
  if (!step || step.tool !== 'learn' || !result || result.ok === false) return null;
  const learned = learnedCount(result);
  if (!learned) return null;
  if (!graph || typeof graph.getEdge !== 'function') return null;
  const workspaceId = state && typeof state.workspaceId === 'string' && state.workspaceId ? state.workspaceId : 'default';
  const edges = claimedEdges(result);
  const { found, missing } = readBack(graph, edges, workspaceId);
  const input = typeof step.input === 'string' ? step.input : null;
  const provenanceId = provenanceIdOf(result);
  const allFound = edges.length > 0 && missing.length === 0;
  // A result that names no edge gives the read-back nothing to check: that is
  // unknown, not a failure -- only an edge that is claimed and absent fails.
  const verdict = edges.length === 0 ? VERDICTS.UNKNOWN : (allFound ? VERDICTS.VERIFIED : VERDICTS.FAILED);
  return {
    verifier: { ...VERIFIER },
    kind: VERIFIER_KINDS.OBSERVATIONAL,
    verdict,
    executor: { ...EXECUTOR },
    channel: { ...CHANNEL },
    scope: { stepId: step.id || null, workspaceId, claimedEdges: edges.length, learned },
    evidence: { found: found.length, missing: missing.slice(0, MAX_LISTED_MISSING), missingCount: missing.length },
    proofs: {
      verification: allFound,
      coverage: edges.length >= learned,
      integrity: found.length > 0 && input !== null
        && found.every((edge) => Array.isArray(edge.evidence) && edge.evidence.includes(input)),
      provenance: found.length > 0 && provenanceId !== null
        && found.every((edge) => edge.provenance && edge.provenance.provenanceId === provenanceId),
      permission: writePermitted(result),
      failureEvidence: missing.length > 0,
    },
  };
}

module.exports = Object.freeze({ assessLearnReadBack, VERIFIER, EXECUTOR, CHANNEL });
