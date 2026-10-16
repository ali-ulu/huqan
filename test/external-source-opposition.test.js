'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { candidateTargetIds } = require('../lib/canonical-target-match');
const { queryCandidateClaims, queryProvenance, queryTrustGraph } = require('../lib/provenance-query');

function fixture() {
  const candidate = {
    candidateId: 'research_external_1',
    claim: 'engine limit is 120 knots',
    proposedEdge: null,
    provenance: {
      provenanceId: 'prov_external_1',
      sourceRef: 'https://example.com/engine',
      sourceTitle: 'External engine page',
      sourceType: 'api',
      sourceSubType: 'web-research:tavily',
      actor: 'web-research',
      confidence: 0.3,
      workspaceId: 'w',
    },
    conflict: {
      conflict: true,
      type: 'external-research-contradiction',
      oppositions: [{
        role: 'external_source_opposition',
        relation: 'OPPOSES',
        targetId: 'engine|has_limit|100 knots',
        rule: 'NUMERICAL_CONFLICT',
        canonicalEdge: {
          from: 'engine',
          relation: 'has_limit',
          to: '100 knots',
          targetId: 'engine|has_limit|100 knots',
          workspaceId: 'w',
          provenanceId: 'prov_canonical_1',
          sourceRef: 'docs/engine.md',
        },
        provenanceId: 'prov_external_1',
        sourceRef: 'https://example.com/engine',
        canonicalWrite: false,
      }],
      workspaceId: 'w',
    },
    recommendation: 'flag',
    status: 'pending',
    workspaceId: 'w',
    warnings: ['external_unverified', 'human_review_required', 'canonical_write_forbidden'],
  };

  const edge = {
    from: 'engine',
    relation: 'has_limit',
    to: '100 knots',
    workspaceId: 'w',
    confidence: 0.9,
    evidence: ['engine limit is 100 knots'],
    provenance: {
      provenanceId: 'prov_canonical_1',
      sourceRef: 'docs/engine.md',
      sourceTitle: 'Engine manual',
      sourceType: 'document',
      sourceSubType: 'manual',
      actor: 'operator',
      confidence: 0.9,
      workspaceId: 'w',
    },
  };

  const graph = {
    _nodes: {},
    _edges: [edge],
    getCandidateClaims(filters = {}) {
      return filters.workspaceId && filters.workspaceId !== 'w' ? [] : [candidate];
    },
    getAuditEvents() { return []; },
    getNode() { return null; },
  };

  return { candidate, edge, graph };
}

test('external opposition targets the canonical edge without contesting its endpoint nodes', () => {
  const { candidate } = fixture();
  const ids = candidateTargetIds(candidate);
  assert.equal(ids.has('engine|has_limit|100 knots'), true);
  assert.equal(ids.has('engine'), false);
  assert.equal(ids.has('100 knots'), false);
});

test('provenance and candidate queries surface external opposition from the canonical edge target', () => {
  const { graph } = fixture();
  const targetId = 'engine|has_limit|100 knots';

  const candidates = queryCandidateClaims(graph, { workspaceId: 'w', targetId });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].candidateId, 'research_external_1');

  const provenance = queryProvenance(graph, { workspaceId: 'w', targetId });
  const external = provenance.find(item => item.kind === 'candidate_claim');
  assert.ok(external);
  assert.equal(external.provenance.sourceRef, 'https://example.com/engine');
  assert.equal(external.conflict.oppositions[0].relation, 'OPPOSES');
});

test('trust graph marks a canonical edge as flagged when a live provenance-bound external opposition targets it', () => {
  const { graph } = fixture();
  const targetId = 'engine|has_limit|100 knots';

  const result = queryTrustGraph(graph, { workspaceId: 'w', targetId });
  assert.equal(result.canonical.targetId, targetId);
  assert.equal(result.status, 'flagged');
  assert.equal(result.receipt.canonical, false);
  assert.equal(result.receipt.candidateClaim.candidateId, 'research_external_1');
  assert.equal(result.receipt.candidateClaim.conflict.oppositions[0].canonicalWrite, false);
});
