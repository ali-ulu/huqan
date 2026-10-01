'use strict';

// Regression: lib/dream-experiment-loop-verify.js must build its default
// CausalSimulator from the module's named export. A default import of the
// module object threw "is not a constructor", the catch swallowed it, and every
// Dream hypothesis without an injected simulator came back 'unknown'.

const assert = require('node:assert/strict');
const test = require('node:test');
const { Graph } = require('../graph');
const { simulateHypothesis } = require('../lib/dream-experiment-loop-verify');

function causalGraph() {
  const graph = new Graph({ noLoad: true });
  graph.addNode('a', 'a');
  graph.addNode('b', 'b');
  graph.addNode('c', 'c');
  graph.addEdge('a', 'b', 'CAUSES', { strength: 0.9, confidence: 0.85, evidence: ['a-b'] });
  return graph;
}

const STATE = { workspaceId: 'default' };

test('default simulator supports a hypothesis backed by a real CAUSES edge', () => {
  const observation = simulateHypothesis({ graph: causalGraph() }, STATE, { key: 'a->b', from: 'a', to: 'b' });

  assert.equal(observation.errorCode, '');
  assert.notEqual(observation.mode, 'error');
  assert.equal(observation.signal, 'support');
  assert.equal(observation.targetFound, true);
  assert.ok(observation.causalChains > 0);
});

test('default simulator stays unknown, without error, when no causal chain reaches the target', () => {
  const observation = simulateHypothesis({ graph: causalGraph() }, STATE, { key: 'a->c', from: 'a', to: 'c' });

  assert.equal(observation.errorCode, '');
  assert.notEqual(observation.mode, 'error');
  assert.equal(observation.signal, 'unknown');
  assert.equal(observation.targetFound, false);
});

test('a kernel without a graph still fails closed as an observed simulation error', () => {
  const observation = simulateHypothesis({}, STATE, { key: 'a->b', from: 'a', to: 'b' });

  assert.equal(observation.signal, 'unknown');
  assert.equal(observation.mode, 'error');
  assert.equal(observation.errorCode, 'CAUSAL_SIMULATION_FAILED');
});
