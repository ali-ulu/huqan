'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildResearchCandidate,
  contradictionSignals,
  openExternalResearchCandidates,
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
    workspaceId: 'w',
    sourceRef: '',
  });
  assert.deepEqual(contradictionSignals([{
    from: 'engine', relation: 'has_limit', to: '100 knots', evidence: ['engine limit is 100 knots'],
  }], 'completely unrelated external statement'), []);
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

  const again = openExternalResearchCandidates(kernelWith([]), {
    provider: 'brave',
    sources: [{ title: 'External', url: 'https://example.com/a', snippet: 'engine limit is 120 knots' }],
  }, { workspaceId: 'w' });
  assert.equal(again.items[0].candidateId, result.items[0].candidateId);
});

test('pipeline fails closed when candidate storage is unavailable', () => {
  assert.throws(
    () => openExternalResearchCandidates({ graph: { getAllEdges: () => [] } }, { sources: [] }, { workspaceId: 'w' }),
    error => error.code === 'RESEARCH_CANDIDATE_PIPELINE_UNAVAILABLE',
  );
});
