'use strict';

const crypto = require('node:crypto');
const { buildCandidateClaim } = require('./conflict-detector');
const { runContradictionRules } = require('./contradiction-rules');
const { hasMeaningfulOverlap, normalizeText, tokenize } = require('./text-utils');

const MAX_GRAPH_EDGES = 500;
const MAX_SIGNALS_PER_SOURCE = 8;
const EXTERNAL_RESEARCH_CONFIDENCE = 0.3;

function digest(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 32);
}

function sourceClaim(source) {
  if (!source || typeof source !== 'object') return '';
  return String(source.snippet || source.title || '').trim().slice(0, 8000);
}

function subjectMentioned(text, subject) {
  const subjectTokens = tokenize(subject);
  if (subjectTokens.length === 0) return false;
  const claimTokens = new Set(tokenize(text));
  return subjectTokens.every(token => claimTokens.has(token));
}

function edgeClaim(edge) {
  const evidence = Array.isArray(edge?.evidence)
    ? edge.evidence.filter(value => typeof value === 'string' && value.trim()).join(' ')
    : (typeof edge?.evidence === 'string' ? edge.evidence : '');
  const fallback = [edge?.from, edge?.relation, edge?.to].filter(Boolean).join(' ');
  return {
    text: (evidence || fallback).trim(),
    subject: String(edge?.from || '').trim(),
    relation: String(edge?.relation || '').trim(),
    object: String(edge?.to || '').trim(),
  };
}

function comparable(edge, claimText) {
  const stored = edgeClaim(edge);
  if (!stored.text || !claimText) return null;
  const mentionsSubject = subjectMentioned(claimText, stored.subject);
  if (!mentionsSubject && !hasMeaningfulOverlap(stored.text, claimText, 3)) return null;
  return {
    stored,
    incoming: {
      text: claimText,
      subject: mentionsSubject ? stored.subject : '',
    },
  };
}

function contradictionSignals(edges, claimText) {
  const signals = [];
  for (const edge of edges) {
    const pair = comparable(edge, claimText);
    if (!pair) continue;
    for (const signal of runContradictionRules(pair.stored, pair.incoming)) {
      signals.push({
        ...signal,
        canonicalEdge: {
          from: edge.from,
          relation: edge.relation,
          to: edge.to,
          workspaceId: edge.workspaceId,
          sourceRef: edge.provenance?.sourceRef || edge.sourceRef || '',
        },
      });
      if (signals.length >= MAX_SIGNALS_PER_SOURCE) return signals;
    }
  }
  return signals;
}

function candidateIds({ workspaceId, provider, source, claim }) {
  const key = JSON.stringify([workspaceId, provider, source.url || '', claim]);
  const hash = digest(key);
  return {
    candidateId: `research_${hash}`,
    provenanceId: `prov_${hash}`,
  };
}

function buildResearchCandidate({ workspaceId, provider, source, claim, signals }) {
  const ids = candidateIds({ workspaceId, provider, source, claim });
  const built = buildCandidateClaim({
    candidateId: ids.candidateId,
    claim,
    workspaceId,
    sourceRef: source.url,
    sourceTitle: source.title || source.url,
    sourceType: 'api',
    sourceSubType: `web-research:${provider}`,
    actor: 'web-research',
    confidence: EXTERNAL_RESEARCH_CONFIDENCE,
    provenance: {
      provenanceId: ids.provenanceId,
      sourceRef: source.url,
      sourceTitle: source.title || source.url,
      sourceType: 'api',
      sourceSubType: `web-research:${provider}`,
      actor: 'web-research',
      confidence: EXTERNAL_RESEARCH_CONFIDENCE,
      workspaceId,
    },
  }, { workspaceId });

  const conflict = {
    conflict: signals.length > 0,
    type: signals.length > 0 ? 'external-research-contradiction' : 'external-research-candidate',
    recommendation: 'flag',
    reason: signals.length > 0
      ? 'Unverified external research contradicts canonical graph evidence and requires human review.'
      : 'Unverified external research requires human review before any canonical admission.',
    signals,
    proposedEvidence: [{ text: claim, role: 'external_research', sourceRef: source.url }],
    workspaceId,
    sourceRef: source.url,
  };

  return {
    ...built.candidate,
    proposedEdge: null,
    conflict,
    recommendation: 'flag',
    status: 'pending',
    reviewedAt: '',
    reviewedBy: '',
    warnings: [...new Set([
      ...(built.warnings || []),
      'external_unverified',
      'human_review_required',
      'canonical_write_forbidden',
    ])],
  };
}

function openExternalResearchCandidates(kernel, researchResult, options = {}) {
  if (!kernel || typeof kernel.addCandidateClaim !== 'function' || !kernel.graph || typeof kernel.graph.getAllEdges !== 'function') {
    const error = new Error('Research candidate pipeline requires a writable Kernel candidate store.');
    error.code = 'RESEARCH_CANDIDATE_PIPELINE_UNAVAILABLE';
    throw error;
  }
  const workspaceId = String(options.workspaceId || researchResult?.workspaceId || 'default').trim() || 'default';
  const provider = String(researchResult?.provider || '').trim();
  const sources = Array.isArray(researchResult?.sources) ? researchResult.sources : [];
  const allEdges = kernel.graph.getAllEdges(workspaceId) || [];
  const edges = allEdges.slice(0, MAX_GRAPH_EDGES);
  const items = [];

  for (const source of sources) {
    const claim = sourceClaim(source);
    if (!claim || !source?.url) continue;
    const signals = contradictionSignals(edges, claim);
    const candidate = buildResearchCandidate({ workspaceId, provider, source, claim, signals });
    const stored = kernel.addCandidateClaim(candidate, { workspaceId });
    items.push({
      candidateId: stored?.candidateId || candidate.candidateId,
      sourceRef: source.url,
      status: 'pending',
      recommendation: 'flag',
      contradictionCount: signals.length,
      contradictionRules: [...new Set(signals.map(signal => signal.rule))],
    });
  }

  return {
    enabled: true,
    opened: items.length,
    contradictions: items.filter(item => item.contradictionCount > 0).length,
    canonicalWrite: false,
    graphEdgesScanned: edges.length,
    graphScanTruncated: allEdges.length > edges.length,
    items,
  };
}

module.exports = {
  EXTERNAL_RESEARCH_CONFIDENCE,
  MAX_GRAPH_EDGES,
  MAX_SIGNALS_PER_SOURCE,
  buildResearchCandidate,
  contradictionSignals,
  openExternalResearchCandidates,
};
