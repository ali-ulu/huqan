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

function canonicalEdgeEvidence(edge) {
  const from = String(edge?.from || '').trim();
  const relation = String(edge?.relation || '').trim();
  const to = String(edge?.to || '').trim();
  const provenance = edge?.provenance && typeof edge.provenance === 'object' ? edge.provenance : {};
  return {
    from,
    relation,
    to,
    targetId: from && relation && to ? `${from}|${relation}|${to}` : '',
    workspaceId: edge?.workspaceId,
    provenanceId: provenance.provenanceId || edge?.provenanceId || '',
    sourceRef: provenance.sourceRef || edge?.sourceRef || '',
    sourceTitle: provenance.sourceTitle || edge?.sourceTitle || '',
    sourceType: provenance.sourceType || edge?.sourceType || '',
    sourceSubType: provenance.sourceSubType || edge?.sourceSubType || '',
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
        canonicalEdge: canonicalEdgeEvidence(edge),
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

function oppositionLinks(signals, provenance, claimText = '') {
  const links = [];
  const byTarget = new Map();
  for (const signal of signals) {
    if (!signal || signal.kind !== 'contradiction' || !signal.canonicalEdge) continue;
    const edge = signal.canonicalEdge;
    const from = String(edge.from || '').trim();
    const relation = String(edge.relation || '').trim();
    const to = String(edge.to || '').trim();
    if (!from || !relation || !to) continue;
    const targetId = edge.targetId || `${from}|${relation}|${to}`;
    const rule = String(signal.rule || '').trim();
    const flags = Array.isArray(signal.flags) ? [...new Set(signal.flags)] : [];

    const existing = byTarget.get(targetId);
    if (existing) {
      if (rule && !existing.rules.includes(rule)) existing.rules.push(rule);
      existing.flags = [...new Set([...existing.flags, ...flags])];
      existing.severity = Math.max(Number(existing.severity) || 0, Number(signal.severity) || 0);
      existing.confidence = Math.max(Number(existing.confidence) || 0, Number(signal.confidence) || 0);
      continue;
    }

    const link = {
      role: 'external_source_opposition',
      relation: 'OPPOSES',
      targetId,
      rule,
      rules: rule ? [rule] : [],
      severity: signal.severity,
      confidence: signal.confidence,
      flags,
      externalClaim: {
        text: String(claimText || '').trim(),
        provenance: provenance && typeof provenance === 'object' ? { ...provenance } : null,
      },
      canonicalEdge: {
        ...edge,
        from,
        relation,
        to,
        targetId,
      },
      provenanceId: provenance?.provenanceId || '',
      sourceRef: provenance?.sourceRef || '',
      canonicalWrite: false,
    };
    byTarget.set(targetId, link);
    links.push(link);
  }
  return links;
}

function summaryProvenance(researchResult, workspaceId) {
  const provider = String(researchResult?.provider || '').trim();
  const sources = Array.isArray(researchResult?.sources) ? researchResult.sources : [];
  const sourceRefs = [...new Set(sources.map(source => source?.url).filter(Boolean))];
  const summaryText = String(researchResult?.summary?.text || '').trim();
  return {
    provenanceId: `summary_${digest(JSON.stringify([workspaceId, provider, sourceRefs, summaryText]))}`,
    sourceRef: sourceRefs[0] || '',
    sourceRefs,
    sourceTitle: 'HUQAN web research summary',
    sourceType: 'derived',
    sourceSubType: `web-research-summary:${provider}`,
    actor: String(researchResult?.summary?.by || 'huqan-llm').trim() || 'huqan-llm',
    confidence: EXTERNAL_RESEARCH_CONFIDENCE,
    workspaceId,
  };
}

function verifyResearchSummary(kernel, researchResult, options = {}) {
  const claim = String(researchResult?.summary?.text || '').trim().slice(0, 8000);
  if (!claim) return null;
  const workspaceId = String(options.workspaceId || researchResult?.workspaceId || 'default').trim() || 'default';
  const provenance = summaryProvenance(researchResult, workspaceId);
  if (!kernel?.graph || typeof kernel.graph.getAllEdges !== 'function') {
    return {
      status: 'unavailable',
      verified: false,
      evidenceStatus: 'external_unverified',
      canonicalWrite: false,
      reason: 'graph_unavailable',
      provenance,
      contradictionCount: 0,
      contradictionRules: [],
      oppositions: [],
    };
  }

  const allEdges = kernel.graph.getAllEdges(workspaceId) || [];
  const edges = allEdges.slice(0, MAX_GRAPH_EDGES);
  const signals = contradictionSignals(edges, claim);
  const oppositions = oppositionLinks(signals, provenance, claim);
  return {
    status: signals.length > 0 ? 'opposed' : 'no_contradiction_found',
    verified: false,
    evidenceStatus: 'external_unverified',
    canonicalWrite: false,
    graphEdgesScanned: edges.length,
    graphScanTruncated: allEdges.length > edges.length,
    contradictionCount: signals.length,
    contradictionRules: [...new Set(signals.map(signal => signal.rule))],
    provenance,
    oppositions,
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
    oppositions: oppositionLinks(signals, built.provenance, claim),
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
      oppositionCount: candidate.conflict.oppositions.length,
      oppositionTargets: [...new Set(candidate.conflict.oppositions.map(item => item.targetId).filter(Boolean))],
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
  oppositionLinks,
  verifyResearchSummary,
  openExternalResearchCandidates,
};
