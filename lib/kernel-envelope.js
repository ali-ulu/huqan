'use strict';

/**
 * HUQAN result-envelope construction and evidence shaping, lifted out of
 * kernel.js verbatim.
 *
 * Kernel's `_ok` / `_fail` / `_validateResult` / `_edgeRef` / `_rankEvidence`
 * / `_edgeEvidence` / `_pathEvidence` remain as methods -- they are called
 * off a kernel instance from lib/verify.js, lib/learn-use-case.js,
 * lib/kernel-read-use-cases.js, plugins and the test suite -- and now
 * delegate here. Every kernel dependency (graph, contractVersion,
 * paranoidMode) arrives as an argument, so this module has no import back
 * into kernel.js.
 */

function validateResult(result) {
  if (!result || typeof result.ok !== 'boolean') throw new Error('Invalid result: ok must be boolean');
  if (!Array.isArray(result.evidence)) throw new Error('Invalid result: evidence must be array');
  if (result.type === 'verify' && result.data) {
    const statuses = new Set(['verified', 'contradicted', 'unknown']);
    if (!statuses.has(result.data.status)) throw new Error('Invalid verify status: ' + result.data.status);
    if (typeof result.data.confidence !== 'number' || result.data.confidence < 0 || result.data.confidence > 1) {
      throw new Error('Invalid confidence: must be between 0 and 1');
    }
  }
  return result;
}

function edgeRef(edge) {
  return { from: edge.from, to: edge.to, relation: edge.relation };
}

function rankEvidence(evidence = []) {
  const seen = new Set();
  return evidence
    .filter(Boolean)
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .filter(item => {
      const key = `${item.kind || 'evidence'}|${item.text || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function ok(context, type, data = null, evidence = [], meta = {}) {
  const { graph, contractVersion, paranoidMode } = context;
  const stats = graph && typeof graph.getStats === 'function' ? graph.getStats() : {};
  return validateResult({
    ok: true,
    type,
    data,
    evidence: rankEvidence(Array.isArray(evidence) ? evidence : []),
    error: null,
    meta: {
      contractVersion,
      backend: stats.backend || 'unknown',
      paranoidMode,
      ...meta,
    },
  });
}

function fail(context, type, code, message, meta = {}) {
  const { contractVersion, paranoidMode } = context;
  return validateResult({
    ok: false,
    type,
    data: null,
    evidence: [],
    error: { code, message },
    meta: {
      contractVersion,
      paranoidMode,
      ...meta,
    },
  });
}

function edgeEvidence(edge, kind = 'direct_edge', confidence) {
  const score = Math.max(0, Math.min(1, confidence ?? edge.confidence ?? edge.weight ?? 0));
  const details = [];
  if (edge.relation) details.push(`relation=${edge.relation}`);
  if (edge.source) details.push(`source=${edge.source}`);
  details.push(`confidence=${score.toFixed(2)}`);
  return {
    kind,
    text: `${edge.from} --[${edge.relation}]--> ${edge.to} (${details.join(', ')})`,
    confidence: score,
    nodes: [edge.from, edge.to],
    edges: [edgeRef(edge)],
  };
}

function pathEvidence(graph, pathArr, kind = 'path', confidence = 0.5, workspaceId = 'default') {
  const edges = [];
  for (let i = 0; i < pathArr.length - 1; i++) {
    const direct = graph.getEdges(pathArr[i], workspaceId).find(e => e.to === pathArr[i + 1]);
    const reverse = graph.getInEdges(pathArr[i], workspaceId).find(e => e.from === pathArr[i + 1]);
    const edge = direct || reverse;
    if (edge) edges.push(edgeRef(edge));
  }
  return {
    kind,
    text: pathArr.join(' -> '),
    confidence: Math.max(0, Math.min(1, confidence)),
    nodes: [...pathArr],
    edges,
  };
}

module.exports = {
  ok,
  fail,
  validateResult,
  edgeRef,
  rankEvidence,
  edgeEvidence,
  pathEvidence,
};
