const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Graph } = require('./graph');
const { CausalSimulator } = require('./causalSimulator');

function buildBranchingGraph() {
  const graph = new Graph({ noLoad: true });
  graph.addNode('A', 'A');
  graph.addNode('B', 'B');
  graph.addNode('C', 'C');
  graph.addNode('D', 'D');
  graph.addNode('E', 'E');

  graph.addEdge('A', 'B', 'CAUSES', {
    strength: 0.9,
    confidence: 0.85,
    evidence: ['a-b'],
  });

  graph.addEdge('A', 'C', 'PREVENTS', {
    strength: 0.95,
    confidence: 0.9,
    evidence: ['a-c'],
  });

  graph.addEdge('A', 'D', 'ENABLES', {
    strength: 0.7,
    confidence: 0.72,
    evidence: ['a-d'],
  });

  graph.addEdge('A', 'E', 'DEPENDS_ON', {
    strength: 0.8,
    confidence: 0.78,
    evidence: ['a-e'],
  });

  return graph;
}

describe('Causal Simulator - v0.7', () => {
  it('CausalSimulator graph instance gerektirir', () => {
    assert.throws(() => {
      new CausalSimulator(null);
    }, /CausalSimulator requires a Graph instance/);

    assert.throws(() => {
      new CausalSimulator({});
    }, /CausalSimulator requires a Graph instance/);

    const graph = new Graph({ noLoad: true });
    const simulator = new CausalSimulator(graph);
    assert.ok(simulator);
  });

  it('simulateChange nodeId gerektirir', () => {
    const graph = new Graph({ noLoad: true });
    const simulator = new CausalSimulator(graph);

    assert.throws(() => {
      simulator.simulateChange({});
    }, /simulateChange requires nodeId/);
  });

  it('simulateChange olmayan node için güvenli hata döndürür', () => {
    const graph = new Graph({ noLoad: true });
    const simulator = new CausalSimulator(graph);

    const result = simulator.simulateChange({ nodeId: 'nonexistent' });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.mode, 'missing-node');
    assert.ok(result.error.includes('not found'));
    assert.ok(Array.isArray(result.unknowns));
    assert.ok(result.unknowns[0].includes('nonexistent'));
    assert.strictEqual(result.causalChains, 0);
    assert.deepStrictEqual(result.affectedNodes, []);
  });

  it('simulateChange deterministik ve yeni output sözleşmesini taşır', () => {
    const graph = buildBranchingGraph();
    const simulator = new CausalSimulator(graph);

    const first = simulator.simulateChange({
      nodeId: 'A',
      action: 'Test change on A',
      changeType: 'modify',
      maxDepth: 10,
    });

    const second = simulator.simulateChange({
      nodeId: 'A',
      action: 'Test change on A',
      changeType: 'modify',
      maxDepth: 10,
    });

    assert.deepStrictEqual(second, first);
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.mode, 'causal-backed');
    assert.strictEqual(first.nodeId, 'A');
    assert.strictEqual(first.action, 'Test change on A');
    assert.strictEqual(first.input.nodeId, 'A');
    assert.strictEqual(first.input.changeType, 'modify');
    assert.strictEqual(first.input.maxDepth, 10);
    assert.strictEqual(first.causalChains, 4);
    assert.strictEqual(first.outcomes.length, 4);
    assert.strictEqual(first.risks.length, 4);
    assert.strictEqual(first.affectedNodes.length, 4);
    assert.strictEqual(first.evidence.length, 4);
    assert.ok(first.summary);
    assert.ok(first.recommendation);
    assert.deepStrictEqual(first.affectedNodes.map(item => item.nodeId), ['B', 'D', 'E', 'C']);
    assert.deepStrictEqual(first.outcomes.map(item => item.relation), ['CAUSES', 'ENABLES', 'DEPENDS_ON', 'PREVENTS']);
    assert.deepStrictEqual(first.outcomes.map(item => item.effect), ['direct', 'enabling', 'dependency', 'blocking']);
  });

  it('simulateChange relation semantiğini korur', () => {
    const graph = buildBranchingGraph();
    const simulator = new CausalSimulator(graph);

    const result = simulator.simulateChange({ nodeId: 'A' });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.outcomes[0].relation, 'CAUSES');
    assert.strictEqual(result.outcomes[0].effect, 'direct');
    assert.strictEqual(result.outcomes[1].relation, 'ENABLES');
    assert.strictEqual(result.outcomes[1].effect, 'enabling');
    assert.strictEqual(result.outcomes[2].relation, 'DEPENDS_ON');
    assert.strictEqual(result.outcomes[2].effect, 'dependency');
    assert.strictEqual(result.outcomes[3].relation, 'PREVENTS');
    assert.strictEqual(result.outcomes[3].effect, 'blocking');
    assert.ok(result.risks.some(risk => risk.relation === 'PREVENTS'));
    assert.ok(result.risks.some(risk => risk.severity === 'critical'));
    assert.ok(result.risks.some(risk => risk.severity === 'high'));
    assert.ok(result.risks.some(risk => risk.severity === 'low'));
  });

  it('simulateChange loop metadata ve unknowns taşır', () => {
    const graph = new Graph({ noLoad: true });
    graph.addNode('A', 'A');
    graph.addNode('B', 'B');

    graph.addEdge('A', 'B', 'CAUSES', { strength: 0.8, confidence: 0.75, evidence: ['a-b'] });
    graph.addEdge('B', 'A', 'CAUSES', { strength: 0.6, confidence: 0.55, evidence: ['b-a'] });

    const simulator = new CausalSimulator(graph);
    const result = simulator.simulateChange({ nodeId: 'A', maxDepth: 5 });

    assert.strictEqual(result.ok, true);
    assert.ok(Array.isArray(result.traversal.loops));
    assert.ok(result.traversal.loops.length > 0);
    assert.ok(result.unknowns.some(item => item.includes('Loop detected')));
  });

  it('simulateChange maxDepth ile durur', () => {
    const graph = new Graph({ noLoad: true });
    graph.addNode('A', 'A');
    graph.addNode('B', 'B');
    graph.addNode('C', 'C');
    graph.addNode('D', 'D');

    graph.addEdge('A', 'B', 'CAUSES', { strength: 0.8, confidence: 0.75, evidence: ['a-b'] });
    graph.addEdge('B', 'C', 'CAUSES', { strength: 0.7, confidence: 0.65, evidence: ['b-c'] });
    graph.addEdge('C', 'D', 'CAUSES', { strength: 0.6, confidence: 0.55, evidence: ['c-d'] });

    const simulator = new CausalSimulator(graph);
    const result = simulator.simulateChange({ nodeId: 'A', maxDepth: 2 });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.input.maxDepth, 2);
    assert.strictEqual(result.traversal.maxDepth, 2);
    assert.strictEqual(result.traversal.stoppedReason, 'maxDepth');
    assert.ok(result.unknowns.some(item => item.includes('maxDepth')));
  });

  it('simulateChange confidence stable kalır', () => {
    const graph = new Graph({ noLoad: true });
    graph.addNode('A', 'A');
    graph.addNode('B', 'B');
    graph.addNode('C', 'C');

    graph.addEdge('A', 'B', 'CAUSES', { strength: 0.8, confidence: 0.75, evidence: ['a-b'] });
    graph.addEdge('B', 'C', 'CAUSES', { strength: 0.7, confidence: 0.65, evidence: ['b-c'] });

    const simulator = new CausalSimulator(graph);
    const result = simulator.simulateChange({ nodeId: 'A' });

    assert.strictEqual(result.ok, true);
    assert.ok(result.confidence > 0);
    assert.ok(result.confidence <= 1);
    assert.ok(result.summary.includes('confidence'));
    assert.ok(result.recommendation);
  });

  it('getCausalRelations graph metodunu çağırır', () => {
    const graph = new Graph({ noLoad: true });
    const simulator = new CausalSimulator(graph);

    const relations = simulator.getCausalRelations();
    assert.strictEqual(Array.isArray(relations), true);
    assert.strictEqual(relations.length, 5);
  });

  it('isCausalRelation graph metodunu çağırır', () => {
    const graph = new Graph({ noLoad: true });
    const simulator = new CausalSimulator(graph);

    assert.strictEqual(simulator.isCausalRelation('CAUSES'), true);
    assert.strictEqual(simulator.isCausalRelation('is_a'), false);
  });

  it('simulateChange evidence ve description içerir', () => {
    const graph = new Graph({ noLoad: true });
    graph.addNode('A', 'A');
    graph.addNode('B', 'B');

    graph.addEdge('A', 'B', 'CAUSES', { strength: 0.8, confidence: 0.75, evidence: ['a-b'] });

    const simulator = new CausalSimulator(graph);
    const result = simulator.simulateChange({ nodeId: 'A' });

    assert.strictEqual(result.ok, true);
    assert.ok(result.outcomes.length > 0);
    assert.ok(result.outcomes[0].description);
    assert.ok(result.outcomes[0].description.includes('A'));
    assert.ok(result.outcomes[0].description.includes('B'));
    assert.deepStrictEqual(result.evidence, ['a-b']);
  });
});
