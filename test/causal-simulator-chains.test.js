'use strict';

// Characterises the per-chain scoring and affected-node dedupe moved out of
// causalSimulator.js (#2187). The numbers are the pre-move output; a change to
// the length penalty or a tie-break must show up here.

const test = require('node:test');
const assert = require('node:assert/strict');

const { scoreChains, dedupeAffectedNodes } = require('../lib/causal-simulator-chains');
const { simulationOverlay } = require('../lib/causal-simulator-scoring');

const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`);

test('scoreChains scores each chain with its length penalty and flags missing evidence', () => {
  const chains = [
    [{ from: 'a', to: 'b', relation: 'CAUSES', strength: 0.9, confidence: 0.8, evidence: ['e1'] }],
    [
      { from: 'a', to: 'b', relation: 'CAUSES', strength: 0.9, confidence: 0.8 },
      { from: 'b', to: 'c', relation: 'PREVENTS', strength: 0.6, confidence: 0.7 },
    ],
  ];
  const result = scoreChains(chains, [{ id: 'b', label: 'Bee' }], simulationOverlay('modify', { enabled: true }));

  close(result.outcomes[0].impact, 0.9, 'one-step impact');
  close(result.outcomes[0].confidence, 0.835, 'one-step confidence');
  close(result.outcomes[1].impact, 0.7245, 'two-step impact carries the 0.92 length penalty');
  close(result.outcomes[1].confidence, 0.69, 'two-step confidence');
  assert.deepEqual(result.outcomes.map((outcome) => outcome.severity), ['critical', 'critical']);
  assert.deepEqual(result.outcomes.map((outcome) => outcome.description), ['a causes b', 'a causes b → b prevents c']);
  assert.equal(result.risks.length, 2);
  assert.deepEqual(result.unknowns, ['Missing evidence for a causes b → b prevents c']);
  close(result.totalConfidence, 1.525, 'total confidence');
  assert.equal(result.confidenceCount, 2);
  assert.deepEqual(result.affectedNodes.map((node) => [node.nodeId, node.label]), [['b', 'Bee'], ['c', 'c']]);
});

test('dedupeAffectedNodes keeps the worst severity, then the highest impact, then the highest confidence', () => {
  const kept = dedupeAffectedNodes([
    { nodeId: 'x', severity: 'medium', impact: 0.5, confidence: 0.5, tag: 'first' },
    { nodeId: 'x', severity: 'medium', impact: 0.6, confidence: 0.1, tag: 'higher-impact' },
    { nodeId: 'x', severity: 'medium', impact: 0.6, confidence: 0.9, tag: 'higher-confidence' },
    { nodeId: 'y', severity: 'high', impact: 0.1, confidence: 0.1, tag: 'y' },
    { nodeId: 'y', severity: 'low', impact: 0.9, confidence: 0.9, tag: 'lower-severity' },
  ]);
  assert.deepEqual(kept.map((item) => [item.nodeId, item.tag]), [['x', 'higher-confidence'], ['y', 'y']]);
});
