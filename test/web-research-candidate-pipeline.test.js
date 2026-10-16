'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildResearchCandidate,
  contradictionSignals,
  openExternalResearchCandidates,
  verifyResearchSummary,
} = require('../lib/web-research-candidate-pipeline');

function kernelWith(edges = []) {
  const writes = [];
  return {
    writes,
    graph: { getAllEdges: () => edges },
    addCandidateClaim(candidate) {
      writes.push(candidate);
      return candidate;
    },
  };
}

test('external research candidates are always pending, flagged and non-canonical', () => {
  const candidate = buildResearchCandidate({
    workspaceId: 'w',
    provider: 'tavily',
    source: { title: 'Source', url: 'https://example.com/a' },
    claim: 'engine limit is 120 knots',
    signals: [],
  });
  assert.equal(candidate.status, 'pending');
  assert.equal(candidate.recommendation, 'flag');
  assert.equal(candidate.proposedEdge, null);
  assert.equal(candidate.provenance.sourceType, 'api');
  assert.equal(candidate.provenance.sourceSubType, 'web-research:tavily');
  assert.equal(candidate.provenance.confidence, 0.3);
  assert.match(candidate.candidateId, /^research_[0-9a-f]{32}$/);
  assert.ok(candidate.warnings.includes('canonical_write_forbidden'));
});

test('research contradiction pass compares relevant canonical edge evidence', () => {
  const signals = contradictionSignals([{
    from: 'engine',
    relation: 'has_limit',
    to: '100 knots',
    workspaceId: 'w',
    evidence: ['engine limit is 100 knots'],
  }], 'engine limit is 120 knots');
  assert.ok(signals.some(signal => signal.rule === 'NUMERICAL_CONFLICT'));
  assert.deepEqual(signals[0].canonicalEdge, {
    from: 'engine',
    relation: 'has_limit',
    to: '100 knots',
    targetId: 'engine|has_limit|100 knots',
    workspaceId: 'w',
    provenanceId: '',
    sourceRef: '',
    sourceTitle: '',
    sourceType: '',
    sourceSubType: '',
  });
  assert.deepEqual(contradictionSignals([{
    from: 'engine', relation: 'has_limit', to: '100 knots', evidence: ['engine limit is 100 knots'],
  }], 'completely unrelated external statement'), []);
});


test('semantic opposition is persisted as provenance-bound graph opposition without a canonical edge proposal', () => {
  const signals = contradictionSignals([{
    from: 'route',
    relation: 'status',
    to: 'güvenli',
    workspaceId: 'w',
    evidence: ['route güvenli'],
    provenance: { sourceRef: 'docs/canonical.md#route' },
  }], 'route riskli');

  const semantic = signals.find(signal => signal.rule === 'SEMANTIC_OPPOSITION');
  assert.ok(semantic);

  const candidate = buildResearchCandidate({
    workspaceId: 'w',
    provider: 'brave',
    source: { title: 'External source', url: 'https://example.com/opposition' },
    claim: 'route riskli',
    signals,
  });

  assert.equal(candidate.proposedEdge, null);
  assert.equal(candidate.status, 'pending');
  assert.equal(candidate.conflict.oppositions.length > 0, true);
  const opposition = candidate.conflict.oppositions.find(item => item.rule === 'SEMANTIC_OPPOSITION');
  assert.ok(opposition);
  assert.equal(opposition.role, 'external_source_opposition');
  assert.equal(opposition.relation, 'OPPOSES');
  assert.equal(opposition.targetId, 'route|status|güvenli');
  assert.equal(opposition.sourceRef, 'https://example.com/opposition');
  assert.equal(opposition.externalClaim.text, 'route riskli');
  assert.equal(opposition.externalClaim.provenance.sourceSubType, 'web-research:brave');
  assert.equal(opposition.provenanceId, candidate.provenance.provenanceId);
  assert.equal(opposition.canonicalEdge.sourceRef, 'docs/canonical.md#route');
  assert.equal(opposition.canonicalWrite, false);
});

test('pipeline opens idempotent pending candidates and never writes canonical graph state', () => {
  const kernel = kernelWith([{
    from: 'engine',
    relation: 'has_limit',
    to: '100 knots',
    workspaceId: 'w',
    evidence: ['engine limit is 100 knots'],
  }]);
  const result = openExternalResearchCandidates(kernel, {
    provider: 'brave',
    sources: [{ title: 'External', url: 'https://example.com/a', snippet: 'engine limit is 120 knots' }],
  }, { workspaceId: 'w' });
  assert.equal(result.enabled, true);
  assert.equal(result.opened, 1);
  assert.equal(result.contradictions, 1);
  assert.equal(result.canonicalWrite, false);
  assert.equal(kernel.writes.length, 1);
  assert.equal(kernel.writes[0].status, 'pending');
  assert.equal(kernel.writes[0].conflict.conflict, true);
  assert.equal(result.items[0].oppositionCount, 1);
  assert.deepEqual(result.items[0].oppositionTargets, ['engine|has_limit|100 knots']);
  assert.deepEqual(
    kernel.writes[0].conflict.oppositions[0].rules,
    ['NUMERICAL_CONFLICT', 'UNIT_CONFLICT']
  );

  const again = openExternalResearchCandidates(kernelWith([]), {
    provider: 'brave',
    sources: [{ title: 'External', url: 'https://example.com/a', snippet: 'engine limit is 120 knots' }],
  }, { workspaceId: 'w' });
  assert.equal(again.items[0].candidateId, result.items[0].candidateId);
});

test('summary verification runs a read-only contradiction pass and never claims truth', () => {
  const kernel = kernelWith([{
    from: 'route',
    relation: 'status',
    to: 'güvenli',
    workspaceId: 'w',
    evidence: ['route güvenli'],
    provenance: {
      provenanceId: 'prov-canonical-route',
      sourceRef: 'docs/route.md',
      sourceTitle: 'Route manual',
      sourceType: 'document',
      sourceSubType: 'manual',
    },
  }]);

  const result = verifyResearchSummary(kernel, {
    provider: 'tavily',
    summary: { text: 'route riskli', by: 'huqan-llm', sources: 2 },
    sources: [
      { url: 'https://example.com/a' },
      { url: 'https://example.com/b' },
    ],
  }, { workspaceId: 'w' });

  assert.equal(result.status, 'opposed');
  assert.equal(result.verified, false);
  assert.equal(result.evidenceStatus, 'external_unverified');
  assert.equal(result.canonicalWrite, false);
  assert.equal(result.contradictionCount > 0, true);
  assert.equal(result.oppositions[0].relation, 'OPPOSES');
  assert.equal(result.oppositions[0].targetId, 'route|status|güvenli');
  assert.equal(result.oppositions[0].canonicalEdge.provenanceId, 'prov-canonical-route');
  assert.deepEqual(result.provenance.sourceRefs, ['https://example.com/a', 'https://example.com/b']);
});

test('summary verification reports unavailable without graph access instead of implying verification', () => {
  const result = verifyResearchSummary(null, {
    provider: 'brave',
    summary: { text: 'external summary', by: 'huqan-llm', sources: 1 },
    sources: [{ url: 'https://example.com/a' }],
  }, { workspaceId: 'w' });

  assert.equal(result.status, 'unavailable');
  assert.equal(result.verified, false);
  assert.equal(result.canonicalWrite, false);
  assert.equal(result.reason, 'graph_unavailable');
});

test('pipeline fails closed when candidate storage is unavailable', () => {
  assert.throws(
    () => openExternalResearchCandidates({ graph: { getAllEdges: () => [] } }, { sources: [] }, { workspaceId: 'w' }),
    error => error.code === 'RESEARCH_CANDIDATE_PIPELINE_UNAVAILABLE',
  );
});
