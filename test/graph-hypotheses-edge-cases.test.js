'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const CLI = require('../cli');
const Graph = require('../graph');
const Kernel = require('../kernel');
const { isolatedGraphOptions, isolatedKernelOptions } = require('./helpers/isolated-persistence');
const { runCliArgv } = require('../lib/cli-workflow-adapter');
const { generateHypotheses } = require('../lib/graph-hypotheses');

function closeGraph(graph) {
  graph?.close?.();
}

function closeManaged({ kernel, cli }) {
  cli?.agent?.storage?.close?.();
  kernel?.graph?.close?.();
  kernel?.memory?.close?.();
}

function createCli(label) {
  const kernel = new Kernel(isolatedKernelOptions(label));
  return { kernel, cli: new CLI({ kernelInstance: kernel }) };
}

function seedCriticalNode(kernel) {
  for (const id of ['a', 'b', 'c']) kernel.graph.addNode(id, id);
  kernel.graph.addEdge('a', 'b', 'supports', { confidence: 0.9, evidence: ['a'] });
  kernel.graph.addEdge('c', 'b', 'supports', { confidence: 0.9, evidence: ['c'] });
}

test('generateHypotheses uses documented defaults for invalid thresholds and handles empty/singleton graphs', () => {
  const empty = new Graph(isolatedGraphOptions('empty-boundary', { noLoad: true }));
  const singleton = new Graph(isolatedGraphOptions('singleton-boundary', { noLoad: true }));
  singleton.addNode('only', 'only');
  try {
    const emptyReport = generateHypotheses(empty, {
      confidenceFloor: 'not-a-number',
      criticalInDegree: 0,
      smallComponentSize: 1,
    });
    const singletonReport = generateHypotheses(singleton, {
      confidenceFloor: 'not-a-number',
      criticalInDegree: 0,
      smallComponentSize: 1,
    });

    for (const report of [emptyReport, singletonReport]) {
      assert.equal(report.meta.confidenceFloor, 0.4);
      assert.equal(report.meta.criticalInDegree, 5);
      assert.equal(report.meta.smallComponentSize, 3);
    }
    assert.deepEqual(emptyReport.hypotheses, []);
    assert.deepEqual(singletonReport.hypotheses, [{
      type: 'YALITILMIŞ_DÜĞÜM',
      severity: 'low',
      target: 'only',
      confidence: 0.2,
      gerekce: 'only düğümünün bağlı olduğu hiçbir kenar yok.',
    }]);
  } finally {
    closeGraph(empty);
    closeGraph(singleton);
  }
});

test('generateHypotheses distinguishes empty evidence, present evidence, and confidence fallback', () => {
  const graph = {
    getNodes: () => ({ a: { id: 'a' }, b: { id: 'b' }, c: { id: 'c' } }),
    getAllEdges: () => [
      { from: 'a', to: 'b', relation: 'supports', confidence: 0.3, evidence: [''] },
      { from: 'b', to: 'c', relation: 'supports', weight: 0.2, evidence: ['manual evidence'] },
    ],
  };

  const report = generateHypotheses(graph, { confidenceFloor: 0.4 });
  assert.equal(report.hypotheses.some(item => item.type === 'KANIT_EKSİK' && item.target === 'b'), true);
  assert.equal(report.hypotheses.some(item => item.type === 'KANIT_EKSİK' && item.target === 'c'), false);
  assert.equal(report.hypotheses.some(item => item.type === 'ZAYIF_BAĞ' && item.target === 'a-[supports]->b'), true);
  assert.equal(report.hypotheses.some(item => item.type === 'ZAYIF_BAĞ' && item.target === 'b-[supports]->c'), true);
});

test('generateHypotheses ignores non-causal cycles and canonicalizes multiple causal cycles', () => {
  const graph = {
    getNodes: () => ({ a: { id: 'a' }, b: { id: 'b' }, c: { id: 'c' }, d: { id: 'd' } }),
    getAllEdges: () => [
      { from: 'a', to: 'b', relation: 'supports', confidence: 0.9 },
      { from: 'b', to: 'a', relation: 'supports', confidence: 0.9 },
      { from: 'a', to: 'b', relation: 'CAUSES', confidence: 0.9 },
      { from: 'b', to: 'a', relation: 'CAUSES', confidence: 0.9 },
      { from: 'c', to: 'd', relation: 'CAUSES', confidence: 0.9 },
      { from: 'd', to: 'c', relation: 'CAUSES', confidence: 0.9 },
    ],
  };

  const report = generateHypotheses(graph);
  const cycles = report.hypotheses.filter(item => item.type === 'NEDENSEL_DÖNGÜ').map(item => item.target);
  assert.deepEqual(cycles, ['a -> b -> a', 'c -> d -> c']);
  assert.equal(report.hypotheses.some(item => item.type === 'NEDENSEL_DÖNGÜ' && item.target.includes('supports')), false);
});

test('plain hypotheses output remains human-readable and default read mode creates no candidate claim', async () => {
  const managed = createCli('plain-read-only');
  try {
    seedCriticalNode(managed.kernel);
    const stdout = [];
    const result = await runCliArgv(['hypotheses', '--critical', '2'], {
      cli: managed.cli,
      stdout: value => stdout.push(value),
    });
    assert.equal(result.exitCode, 0);
    assert.match(stdout[0], /Hipotez raporu — workspace: default/);
    assert.match(stdout[0], /KRİTİK_DÜĞÜM/);
    assert.equal(managed.kernel.getCandidateClaims({ workspaceId: 'default' }).length, 0);
    assert.equal(managed.kernel.graph.getAuditEvents({ workspaceId: 'default' }).some(event => event.targetType === 'cli_mutation'), false);
  } finally {
    closeManaged(managed);
  }
});

test('hypotheses --propose with no high-severity result queues nothing and does not commit', async () => {
  const managed = createCli('no-high-proposal');
  try {
    managed.kernel.graph.addNode('only', 'only');
    const stdout = [];
    const result = await runCliArgv(['hypotheses', '--propose', '--json'], {
      cli: managed.cli,
      stdout: value => stdout.push(value),
    });
    assert.equal(result.exitCode, 0);
    const envelope = JSON.parse(stdout[0]);
    assert.equal(envelope.data.proposal.queued, 0);
    assert.equal(managed.kernel.getCandidateClaims({ workspaceId: 'default' }).length, 0);
    const auditEvents = managed.kernel.graph.getAuditEvents({ workspaceId: 'default' })
      .filter(event => event.targetType === 'cli_mutation');
    assert.equal(auditEvents.length, 1);
    assert.equal(auditEvents[0].details.phase, 'attempted');
  } finally {
    closeManaged(managed);
  }
});

test('hypotheses --propose fails closed when the CLI audit sink is unavailable', async () => {
  const managed = createCli('audit-failure');
  try {
    seedCriticalNode(managed.kernel);
    managed.kernel.recordCliMutationAudit = () => ({ auditRecorded: false, errorCode: 'TEST_AUDIT_FAILURE' });
    const stdout = [];
    const result = await runCliArgv(['hypotheses', '--critical', '2', '--propose', '--json'], {
      cli: managed.cli,
      stdout: value => stdout.push(value),
    });
    const envelope = JSON.parse(stdout[0]);
    assert.equal(result.exitCode, 6);
    assert.equal(envelope.status, 'blocked');
    assert.equal(managed.kernel.getCandidateClaims({ workspaceId: 'default' }).length, 0);
  } finally {
    closeManaged(managed);
  }
});

test('repeated proposal runs replace the deterministic candidate instead of duplicating it', async () => {
  const managed = createCli('repeat-proposal');
  try {
    seedCriticalNode(managed.kernel);
    for (let index = 0; index < 2; index += 1) {
      const stdout = [];
      const result = await runCliArgv(['hypotheses', '--critical', '2', '--propose', '--json'], {
        cli: managed.cli,
        stdout: value => stdout.push(value),
      });
      assert.equal(result.exitCode, 0);
      assert.equal(JSON.parse(stdout[0]).data.proposal.queued, 1);
    }
    const candidates = managed.kernel.getCandidateClaims({ workspaceId: 'default' });
    assert.equal(candidates.length, 1);
    assert.match(candidates[0].candidateId, /^cand_hyp_[a-f0-9]{24}$/);
  } finally {
    closeManaged(managed);
  }
});

test('generateHypotheses filters mixed workspace records even when a read adapter returns unscoped data', () => {
  const graph = {
    getNodes: () => ({
      'other::a': { id: 'a', workspaceId: 'other' },
      'default::b': { id: 'b', workspaceId: 'default' },
    }),
    getAllEdges: () => [
      { from: 'a', to: 'b', relation: 'supports', confidence: 0.2, evidence: [], workspaceId: 'other' },
    ],
  };

  const report = generateHypotheses(graph, { workspaceId: 'default' });
  assert.equal(report.meta.workspaceId, 'default');
  assert.equal(report.meta.nodeCount, 1);
  assert.equal(report.meta.edgeCount, 0);
  assert.equal(report.hypotheses.some(item => item.target.includes('a')), false);
  assert.deepEqual(report.hypotheses.map(item => item.type), ['YALITILMIŞ_DÜĞÜM']);
});

test('generateHypotheses reports only the bounded small component outside the largest component', () => {
  const graph = {
    getNodes: () => ({
      a: { id: 'a' },
      b: { id: 'b' },
      c: { id: 'c' },
      d: { id: 'd' },
      e: { id: 'e' },
    }),
    getAllEdges: () => [
      { from: 'a', to: 'b', relation: 'supports', confidence: 0.9, evidence: ['e'] },
      { from: 'b', to: 'c', relation: 'supports', confidence: 0.9, evidence: ['e'] },
      { from: 'd', to: 'e', relation: 'supports', confidence: 0.9, evidence: ['e'] },
    ],
  };

  const report = generateHypotheses(graph, { smallComponentSize: 2 });
  const small = report.hypotheses.filter(item => item.type === 'KÜÇÜK_BİLEŞEN');
  assert.equal(small.length, 1);
  assert.equal(small[0].target, 'd + e');
});

test('generateHypotheses locks exact confidence and in-degree boundary semantics', () => {
  const graph = {
    getNodes: () => ({ a: { id: 'a' }, b: { id: 'b' }, c: { id: 'c' } }),
    getAllEdges: () => [
      { from: 'a', to: 'b', relation: 'supports', confidence: 0.4, evidence: ['e'] },
      { from: 'c', to: 'b', relation: 'supports', confidence: 0.9, evidence: ['e'] },
    ],
  };

  const report = generateHypotheses(graph, { confidenceFloor: 0.4, criticalInDegree: 2 });
  assert.equal(report.hypotheses.some(item => item.type === 'ZAYIF_BAĞ' && item.target === 'a-[supports]->b'), false);
  assert.equal(report.hypotheses.some(item => item.type === 'KRİTİK_DÜĞÜM' && item.target === 'b'), true);
});

test('generateHypotheses treats a causal self-loop as one canonical cycle and ignores a non-causal self-loop', () => {
  const graph = {
    getNodes: () => ({ a: { id: 'a' }, b: { id: 'b' } }),
    getAllEdges: () => [
      { from: 'a', to: 'a', relation: 'CAUSES', confidence: 0.9, strength: 0.9, evidence: ['e'] },
      { from: 'b', to: 'b', relation: 'supports', confidence: 0.9, evidence: ['e'] },
    ],
  };

  const report = generateHypotheses(graph);
  const cycles = report.hypotheses.filter(item => item.type === 'NEDENSEL_DÖNGÜ');
  assert.deepEqual(cycles.map(item => item.target), ['a -> a']);
  assert.equal(cycles.length, 1);
});
