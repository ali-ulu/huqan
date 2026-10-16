'use strict';

// The blast radius of a learn write, measured on the graph before the write,
// and the justification it adds to the memory admission receipt (#2505).

const assert = require('node:assert/strict');
const test = require('node:test');
const { Graph } = require('../graph');
const { evaluateLearnAdmission } = require('../lib/kernel-learn-admission');
const { buildLearnAdmissionRequest } = require('../lib/learn-admission-request');
const { evaluateMemoryAdmission } = require('../lib/memory-admission-gate');
const { memoryWriteBlastRadius, memoryWriteJustification } = require('../lib/memory-blast-radius');
const { isolatedGraphOptions } = require('./helpers/isolated-persistence');

// In-memory only: no SQLite file, and the JSON path sits in a temporary root.
const newGraph = () => new Graph(isolatedGraphOptions('memory-blast-radius'));

// A kernel reduced to what the measurement reads: a graph, and a parser that
// turns each "subject > object" line into one fact with `relation`.
function kernelWith(graph, relation = 'tür') {
  return {
    graph,
    plugins: { emit: () => {} },
    isStopWord: () => false,
    extractFacts: (text) => String(text).split('\n').filter(Boolean).map((line) => {
      const [subject, object] = line.split('>').map((part) => part.trim());
      return { subject, predicate: object };
    }),
    parsePredicate: (predicate) => ({ object: predicate, relation }),
  };
}

function graphWithDependents(hub, count, relation = 'is_a') {
  const graph = newGraph();
  graph.addNode(hub, hub);
  for (let i = 0; i < count; i += 1) {
    graph.addNode(`n${i}`, `n${i}`);
    graph.addEdge(`n${i}`, hub, relation);
  }
  return graph;
}

test('a fact between two new nodes is reversible and has nothing depending on it', () => {
  const result = memoryWriteBlastRadius(kernelWith(newGraph()), 'kedi > hayvan');
  assert.deepEqual(result.dimensions.breadth, {
    value: 'single', source: '1 fact(s) touching 2 node(s); derived cross-link edges are not counted',
  });
  assert.deepEqual(result.dimensions.dependency, { value: 'none', source: 'every touched node is new' });
  assert.equal(result.dimensions.reversibility.value, 'reversible');
  assert.equal(result.dimensions.boundary.value, 'workspace');
  // MEMORY_WRITE is HIGH, base 65, x0.75 reversible.
  assert.equal(result.score, 49);
  assert.equal(result.level, 'medium');
  assert.equal(result.status, 'computed');
});

test('dependents are counted over relations the causal chain does not follow', () => {
  // A new subject pointing at an existing object: removable, but the object's
  // dependents are within reach.
  const bounded = memoryWriteBlastRadius(kernelWith(graphWithDependents('hayvan', 3)), 'kedi > hayvan');
  assert.equal(bounded.dimensions.dependency.value, 'bounded');
  assert.match(bounded.dimensions.dependency.source, /^3 dependent node\(s\)/);
  assert.equal(bounded.dimensions.reversibility.value, 'reversible');
  // 65 x1.25 bounded x0.75 reversible.
  assert.equal(bounded.score, 61);
  assert.equal(bounded.status, 'computed');

  const broad = memoryWriteBlastRadius(kernelWith(graphWithDependents('hayvan', 12)), 'kedi > hayvan');
  assert.equal(broad.dimensions.dependency.value, 'broad');
  assert.match(broad.dimensions.dependency.source, /^12 dependent node\(s\)/);
});

test('causal consequences downstream of an existing node count as dependents', () => {
  const graph = newGraph();
  graph.addNode('yağmur', 'yağmur');
  graph.addNode('ıslaklık', 'ıslaklık');
  graph.addEdge('yağmur', 'ıslaklık', 'CAUSES', { strength: 0.9, confidence: 0.9, evidence: ['obs'] });
  const result = memoryWriteBlastRadius(kernelWith(graph), 'yağmur > hava');
  assert.equal(result.dimensions.dependency.value, 'bounded');
  assert.match(result.dimensions.dependency.source, /^1 dependent node\(s\)/);
});

test('a fact whose subject already exists is not assumed reversible', () => {
  const graph = newGraph();
  graph.addNode('hayvan', 'hayvan');
  const result = memoryWriteBlastRadius(kernelWith(graph), 'hayvan > canlı');
  assert.equal(result.dimensions.reversibility.value, 'unknown');
  assert.match(result.dimensions.reversibility.reason, /existing subject node/);
  assert.equal(result.status, 'upper_bound');
});

test('a negation is not assumed reversible, even on a new subject', () => {
  const result = memoryWriteBlastRadius(kernelWith(newGraph(), 'değil'), 'balina > balık');
  assert.equal(result.dimensions.reversibility.value, 'unknown');
  assert.match(result.dimensions.reversibility.reason, /negation lowers the weight of existing edges/);
});

test('more than one fact is multiple breadth', () => {
  const result = memoryWriteBlastRadius(kernelWith(newGraph()), 'a > b\nc > d');
  assert.equal(result.dimensions.breadth.value, 'multiple');
  assert.match(result.dimensions.breadth.source, /^2 fact\(s\) touching 4 node\(s\)/);
});

test('a traversal stopped by its budget is recorded as unknown, not as a partial count', () => {
  const result = memoryWriteBlastRadius(kernelWith(graphWithDependents('hayvan', 600)), 'kedi > hayvan');
  assert.equal(result.dimensions.dependency.value, 'unknown');
  assert.match(result.dimensions.dependency.reason, /not fully traversed \(max_nodes\)/);
  assert.equal(result.status, 'upper_bound');
});

test('without a graph to measure, every measured dimension is unknown and the score is an upper bound', () => {
  const result = memoryWriteBlastRadius({ plugins: { emit: () => {} } }, 'kedi > hayvan');
  for (const name of ['breadth', 'dependency', 'reversibility']) {
    assert.equal(result.dimensions[name].value, 'unknown');
  }
  assert.equal(result.score, 100);
  assert.equal(result.status, 'upper_bound');
});

test('a measurement that throws is recorded with its reason', () => {
  const kernel = { ...kernelWith(newGraph()), extractFacts: () => { throw new Error('parser down'); } };
  const result = memoryWriteBlastRadius(kernel, 'kedi > hayvan');
  assert.equal(result.dimensions.dependency.reason, 'measurement failed: parser down');
});

test('text with no fact writes no graph node or edge: measured as 0, not unknown', () => {
  const kernel = { ...kernelWith(newGraph()), extractFacts: () => [] };
  const result = memoryWriteBlastRadius(kernel, 'nothing to learn');
  assert.equal(result.dimensions.breadth.value, 'none');
  assert.equal(result.dimensions.dependency.value, 'not_applicable');
  assert.equal(result.dimensions.reversibility.value, 'not_applicable');
  assert.equal(result.score, 0);
  assert.equal(result.level, 'low');
  assert.equal(result.status, 'computed');
});

test('with the Rust engine attached, text with no fact stays unknown, because the engine still receives it', () => {
  const kernel = { ...kernelWith(newGraph()), extractFacts: () => [], _rust: { learn: async () => {} } };
  const result = memoryWriteBlastRadius(kernel, 'nothing to learn');
  assert.equal(result.dimensions.breadth.value, 'unknown');
  assert.match(result.dimensions.breadth.reason, /Rust engine/);
  assert.equal(result.status, 'upper_bound');
});

test('the justification does not change the admission decision', () => {
  const kernel = kernelWith(newGraph());
  const text = 'kedi > hayvan';
  const request = buildLearnAdmissionRequest({ text, opts: {}, provenance: null, workspaceId: 'default', contractVersion: 'test' });
  const plain = evaluateMemoryAdmission(request, { approvalRequired: request.approvalRequired });
  const justified = evaluateMemoryAdmission(request, {
    approvalRequired: request.approvalRequired,
    metadata: { justification: memoryWriteJustification(kernel, text, 'default', request) },
  });
  assert.equal(justified.decision.decision, plain.decision.decision);
  assert.equal(justified.decision.reason, plain.decision.reason);
  assert.deepEqual(justified.decision.risk, plain.decision.risk);
  assert.equal(justified.receipt.riskScore, plain.receipt.riskScore);
  assert.equal(plain.receipt.metadata.justification, undefined);
  assert.equal(justified.receipt.metadata.justification.blastRadius.score, 49);
});

test('a learn admission receipt records why it was decided', () => {
  const result = evaluateLearnAdmission({
    kernel: kernelWith(newGraph()),
    isLearnAdmissionBypass: () => false,
    contractVersion: 'test',
  }, 'kedi > hayvan', {}, null, 'default');
  const { justification } = result.receipt.metadata;
  assert.equal(justification.riskScoreState, 'computed');
  assert.equal(justification.riskScore, result.receipt.riskScore);
  assert.equal(justification.blastRadius.dimensions.dependency.value, 'none');
  assert.deepEqual(justification.thresholds.levelBands[0], { floor: 75, level: 'CRITICAL' });
  assert.equal(justification.thresholds.decisionSource, 'memory_admission_gate');
  assert.equal(justification.thresholds.blastRadiusEnforced, false);
});

test('a request without a risk score is recorded as unknown, never as 0', () => {
  const justification = memoryWriteJustification(kernelWith(newGraph()), 'kedi > hayvan', 'default', {});
  assert.equal(justification.riskScore, null);
  assert.equal(justification.riskScoreState, 'unknown');
});

test('a touched node is not counted as a dependent of another touched node', () => {
  // Re-learning an existing fact: kedi already points at hayvan, and both are
  // written by this learn, so kedi is part of the write, not downstream of it.
  const graph = newGraph();
  graph.addNode('kedi', 'kedi');
  graph.addNode('hayvan', 'hayvan');
  graph.addEdge('kedi', 'hayvan', 'is_a');
  const result = memoryWriteBlastRadius(kernelWith(graph), 'kedi > hayvan');
  assert.equal(result.dimensions.dependency.value, 'none');
  assert.match(result.dimensions.dependency.source, /^0 dependent node\(s\)/);
});
