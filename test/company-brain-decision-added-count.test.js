'use strict';

/**
 * `added` must count every edge ingestDecision writes.
 *
 * It was `rationaleEdge.edge ? 1 : 0`, so the alternatives and links loops
 * below it contributed nothing. A decision carrying one alternative and two
 * links wrote four edges and reported `added: 1` -- and since the same number
 * is passed to trackSuccess, the `decision` share of
 * ingestStatus.distribution drifted low with every such ingest.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const companyBrain = require('../plugins/company-brain');

function makeKernel({ rejectRelation = null } = {}) {
  const edges = [];
  return {
    edges,
    graph: { getStats: () => ({ nodes: 0, edges: edges.length }) },
    proposeNode: (id) => ({ decision: 'allow', node: { id } }),
    proposeEdge: (from, to, relation) => {
      if (relation === rejectRelation) return { decision: 'reject' };
      edges.push({ from, to, relation });
      return { decision: 'allow', edge: { from, to, relation } };
    },
  };
}

const DECISION = {
  title: 'Veri saklama politikasi',
  rationale: 'GDPR uyumu',
  date: '2026-08-23',
  decidedBy: 'ali',
};

test('added counts the rationale, the alternatives and the links', () => {
  const kernel = makeKernel();

  const result = companyBrain._test.ingestDecision(kernel, {
    ...DECISION,
    alternatives: ['7 yil saklama'],
    links: ['policy:gdpr', 'policy:kvkk'],
  });

  assert.equal(result.ok, true);
  assert.equal(kernel.edges.length, 4, 'the fixture must actually write four edges');
  assert.equal(result.added, 4);
});

test('a decision with no alternatives or links still counts its rationale', () => {
  const kernel = makeKernel();

  const result = companyBrain._test.ingestDecision(kernel, DECISION);

  assert.equal(result.added, 1);
  assert.equal(kernel.edges.length, 1);
});

test('added matches what the ingest distribution records', () => {
  const kernel = makeKernel();

  const result = companyBrain._test.ingestDecision(kernel, {
    ...DECISION,
    alternatives: ['7 yil saklama', '30 gun saklama'],
    links: ['policy:gdpr'],
  });

  assert.equal(companyBrain._test.getIngestStatus(kernel).distribution.decision, result.added);
  assert.equal(result.added, kernel.edges.length);
});

test('an edge that is refused is not counted', () => {
  const kernel = makeKernel({ rejectRelation: 'alternatif' });

  const result = companyBrain._test.ingestDecision(kernel, {
    ...DECISION,
    alternatives: ['7 yil saklama'],
    links: ['policy:gdpr'],
  });

  assert.equal(kernel.edges.length, 2, 'the alternative edge must have been refused');
  assert.equal(result.added, 2);
});
