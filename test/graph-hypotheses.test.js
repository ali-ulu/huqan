'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Graph = require('../graph');
const { isolatedGraphOptions } = require('./helpers/isolated-persistence');
const {
  buildHypothesisCandidate,
  generateHypotheses,
} = require('../lib/graph-hypotheses');

function seededGraph(label = 'hypotheses') {
  const graph = new Graph(isolatedGraphOptions(label, { noLoad: true }));
  for (const id of ['a', 'b', 'c', 'd', 'x', 'y', 'z']) graph.addNode(id, id);
  graph.addEdge('a', 'b', 'CAUSES', { confidence: 0.8, strength: 0.8, evidence: [] });
  graph.addEdge('b', 'c', 'CAUSES', { confidence: 0.8, strength: 0.8, evidence: [] });
  graph.addEdge('c', 'a', 'CAUSES', { confidence: 0.8, strength: 0.8, evidence: [] });
  graph.addEdge('d', 'b', 'supports', { confidence: 0.2, evidence: ['manual note'] });
  graph.addEdge('x', 'y', 'bag', { confidence: 0.1, evidence: [] });
  return graph;
}

test('generateHypotheses detects all six rules deterministically', () => {
  const graph = seededGraph('all-rules');
  try {
    const options = { criticalInDegree: 2, confidenceFloor: 0.4, smallComponentSize: 2 };
    const first = generateHypotheses(graph, options);
    const second = generateHypotheses(graph, options);

    assert.deepEqual(first, second);
    assert.equal(first.meta.nodeCount, 7);
    assert.equal(first.meta.edgeCount, 5);
    assert.equal(first.hypotheses.some(item => item.type === 'KANIT_EKSİK' && item.target === 'a'), true);
    assert.equal(first.hypotheses.some(item => item.type === 'KANIT_EKSİK' && item.target === 'c'), true);
    assert.equal(first.hypotheses.some(item => item.type === 'KRİTİK_DÜĞÜM' && item.target === 'b'), true);
    assert.equal(first.hypotheses.some(item => item.type === 'YALITILMIŞ_DÜĞÜM' && item.target === 'z'), true);
    assert.equal(first.hypotheses.some(item => item.type === 'ZAYIF_BAĞ' && item.target === 'd-[supports]->b'), true);
    assert.equal(first.hypotheses.some(item => item.type === 'ZAYIF_BAĞ' && item.target === 'x-[bag]->y'), true);
    assert.equal(first.hypotheses.some(item => item.type === 'NEDENSEL_DÖNGÜ' && item.target === 'a -> b -> c -> a'), true);
    assert.equal(first.hypotheses.some(item => item.type === 'KÜÇÜK_BİLEŞEN' && item.target === 'x + y'), true);
  } finally {
    graph.close();
  }
});

test('generateHypotheses is workspace-scoped and does not leak nodes or edges', () => {
  const graph = new Graph(isolatedGraphOptions('workspace-scope', { noLoad: true }));
  try {
    graph.addNode('shared', 'shared', null, { workspaceId: 'default' });
    graph.addNode('default-target', 'target', null, { workspaceId: 'default' });
    graph.addNode('shared', 'shared', null, { workspaceId: 'tenant-a' });
    graph.addNode('tenant-target', 'target', null, { workspaceId: 'tenant-a' });
    graph.addEdge('shared', 'default-target', 'supports', { workspaceId: 'default', confidence: 0.9, evidence: ['default'] });
    graph.addEdge('shared', 'tenant-target', 'supports', { workspaceId: 'tenant-a', confidence: 0.9, evidence: ['tenant'] });

    const report = generateHypotheses(graph, { workspaceId: 'default' });
    assert.equal(report.meta.workspaceId, 'default');
    assert.equal(report.meta.nodeCount, 2);
    assert.equal(report.meta.edgeCount, 1);
    assert.equal(report.hypotheses.some(item => item.target.includes('tenant')), false);
  } finally {
    graph.close();
  }
});

test('buildHypothesisCandidate gives high-severity proposals stable identity and review flag', () => {
  const hypothesis = {
    type: 'KRİTİK_DÜĞÜM',
    severity: 'high',
    target: 'b',
    confidence: 0.9,
    gerekce: 'b kritik düğüm.',
  };
  const first = buildHypothesisCandidate(hypothesis, 'default');
  const second = buildHypothesisCandidate(hypothesis, 'default');
  assert.equal(first.candidateId, second.candidateId);
  assert.equal(first.provenance.provenanceId, second.provenance.provenanceId);
  assert.equal(first.recommendation, 'flag');
  assert.equal(first.status, 'pending');
  assert.equal(first.workspaceId, 'default');
});
