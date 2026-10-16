'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const CLI = require('../cli');
const Kernel = require('../kernel');
const { isolatedKernelOptions } = require('./helpers/isolated-persistence');
const { runCliArgv } = require('../lib/cli-workflow-adapter');
const { buildHypothesisCandidate } = require('../lib/graph-hypotheses');
const { reviewHypothesisCandidate } = require('../lib/hypothesis-review');
const { COMPONENT_WEIGHTS, buildFitnessReport } = require('../lib/hypothesis-fitness');

function createCli(label) {
  const kernel = new Kernel(isolatedKernelOptions(label));
  const cli = new CLI({ kernelInstance: kernel });
  return { kernel, cli };
}

function closeCli({ kernel, cli }) {
  cli?.agent?.storage?.close?.();
  kernel?.graph?.close?.();
  kernel?.memory?.close?.();
}

/** Four nodes, every edge carrying evidence, no isolated node, no cycle. */
function seedHealthyGraph(kernel, workspaceId = 'default') {
  for (const id of ['a', 'b', 'c', 'd']) kernel.graph.addNode(id, id, null, { workspaceId });
  kernel.graph.addEdge('a', 'b', 'supports', { workspaceId, confidence: 0.9, evidence: ['kanit-1'] });
  kernel.graph.addEdge('b', 'c', 'supports', { workspaceId, confidence: 0.9, evidence: ['kanit-2'] });
  kernel.graph.addEdge('c', 'd', 'supports', { workspaceId, confidence: 0.9, evidence: ['kanit-3'] });
}

function componentOf(report, name) {
  return report.components.find(item => item.name === name);
}

test('a fully evidenced, connected, acyclic graph scores high', async () => {
  const managed = createCli('fitness-healthy');
  try {
    seedHealthyGraph(managed.kernel);
    const report = buildFitnessReport(managed.kernel);
    assert.equal(componentOf(report, 'evidenceCoverage').value, 1);
    assert.equal(componentOf(report, 'connectivity').value, 1);
    assert.equal(componentOf(report, 'consistency').value, 1);
    assert.equal(report.score, 1);
    assert.equal(report.grade, 'A');
  } finally {
    closeCli(managed);
  }
});

test('an edge without evidence lowers evidence coverage', async () => {
  const managed = createCli('fitness-coverage');
  try {
    const kernel = managed.kernel;
    seedHealthyGraph(kernel);
    kernel.graph.addNode('e', 'e', null, { workspaceId: 'default' });
    kernel.graph.addEdge('d', 'e', 'supports', { workspaceId: 'default', confidence: 0.9, evidence: [] });
    const report = buildFitnessReport(kernel);
    assert.equal(componentOf(report, 'evidenceCoverage').value, 3 / 4);
    assert.ok(report.score < 1);
  } finally {
    closeCli(managed);
  }
});

test('an isolated node lowers connectivity', async () => {
  const managed = createCli('fitness-connectivity');
  try {
    const kernel = managed.kernel;
    seedHealthyGraph(kernel);
    kernel.graph.addNode('lonely', 'lonely', null, { workspaceId: 'default' });
    const report = buildFitnessReport(kernel);
    assert.equal(componentOf(report, 'connectivity').value, 4 / 5);
    assert.equal(componentOf(report, 'evidenceCoverage').value, 1, 'coverage is unaffected by a node with no edges');
  } finally {
    closeCli(managed);
  }
});

test('a causal cycle lowers consistency', async () => {
  const managed = createCli('fitness-consistency');
  try {
    const kernel = managed.kernel;
    for (const id of ['x', 'y']) kernel.graph.addNode(id, id, null, { workspaceId: 'default' });
    kernel.graph.addEdge('x', 'y', 'CAUSES', { workspaceId: 'default', confidence: 0.9, strength: 0.9, evidence: ['k'] });
    kernel.graph.addEdge('y', 'x', 'CAUSES', { workspaceId: 'default', confidence: 0.9, strength: 0.9, evidence: ['k'] });
    const report = buildFitnessReport(kernel);
    const consistency = componentOf(report, 'consistency');
    assert.ok(consistency.value < 1);
    assert.equal(consistency.detail.cycles, 1);
  } finally {
    closeCli(managed);
  }
});

test('hypothesis accuracy is null until something has been reviewed, then reflects the verdicts', async () => {
  const managed = createCli('fitness-accuracy');
  try {
    const kernel = managed.kernel;
    seedHealthyGraph(kernel);
    assert.equal(componentOf(buildFitnessReport(kernel), 'hypothesisAccuracy').value, null);

    const candidates = ['KRİTİK_DÜĞÜM', 'KRİTİK_DÜĞÜM'].map((type, index) => {
      const candidate = buildHypothesisCandidate({
        type, severity: 'high', target: `t${index}`, confidence: 0.9, gerekce: `${type} ${index}.`,
      }, 'default');
      kernel.addCandidateClaim(candidate, { workspaceId: 'default' });
      return candidate;
    });
    reviewHypothesisCandidate(kernel, { candidateId: candidates[0].candidateId, decision: 'accept' });
    reviewHypothesisCandidate(kernel, { candidateId: candidates[1].candidateId, decision: 'reject' });

    assert.equal(componentOf(buildFitnessReport(kernel), 'hypothesisAccuracy').value, 0.5);
  } finally {
    closeCli(managed);
  }
});

test('a null component is excluded from the score rather than counted as zero', async () => {
  const managed = createCli('fitness-null-component');
  try {
    const kernel = managed.kernel;
    seedHealthyGraph(kernel);
    const report = buildFitnessReport(kernel);
    // Accuracy is the only null here; the other three are perfect, so a null
    // treated as zero would drag the score below 1.
    assert.equal(componentOf(report, 'hypothesisAccuracy').value, null);
    assert.equal(report.score, 1);
    assert.equal(report.meta.weightUsed, COMPONENT_WEIGHTS.evidenceCoverage
      + COMPONENT_WEIGHTS.connectivity + COMPONENT_WEIGHTS.consistency);
  } finally {
    closeCli(managed);
  }
});

test('an empty graph reports every component as null and no score', async () => {
  const managed = createCli('fitness-empty');
  try {
    const report = buildFitnessReport(managed.kernel);
    assert.deepEqual(report.components.map(item => item.value), [null, null, null, null]);
    assert.equal(report.score, null);
    assert.equal(report.grade, null);
  } finally {
    closeCli(managed);
  }
});

test('the report is deterministic and lists components in a fixed order', async () => {
  const managed = createCli('fitness-deterministic');
  try {
    seedHealthyGraph(managed.kernel);
    const first = buildFitnessReport(managed.kernel);
    assert.deepEqual(first, buildFitnessReport(managed.kernel));
    assert.deepEqual(first.components.map(item => item.name),
      ['evidenceCoverage', 'hypothesisAccuracy', 'connectivity', 'consistency']);
  } finally {
    closeCli(managed);
  }
});

test('workspace isolation holds', async () => {
  const managed = createCli('fitness-workspace');
  try {
    seedHealthyGraph(managed.kernel, 'alpha');
    const alpha = buildFitnessReport(managed.kernel, { workspaceId: 'alpha' });
    const beta = buildFitnessReport(managed.kernel, { workspaceId: 'beta' });
    assert.equal(alpha.meta.nodeCount, 4);
    assert.equal(beta.meta.nodeCount, 0);
    assert.equal(beta.score, null);
  } finally {
    closeCli(managed);
  }
});

test('the report writes nothing and optimizes nothing', async () => {
  const managed = createCli('fitness-read-only');
  try {
    const kernel = managed.kernel;
    seedHealthyGraph(kernel);
    const calls = [];
    for (const method of ['addNode', 'addEdge', 'addCandidateClaim', 'appendAuditEvent']) {
      const original = kernel.graph[method].bind(kernel.graph);
      kernel.graph[method] = (...args) => { calls.push(method); return original(...args); };
    }
    buildFitnessReport(kernel);
    assert.deepEqual(calls, []);
  } finally {
    closeCli(managed);
  }
});

test('hypotheses fitness is reachable from the CLI and emits a JSON workflow envelope', async () => {
  const managed = createCli('fitness-cli');
  try {
    seedHealthyGraph(managed.kernel);
    const stdout = [];
    const result = await runCliArgv(['hypotheses', 'fitness', '--json'], {
      cli: managed.cli,
      stdout: value => stdout.push(value),
    });
    const envelope = JSON.parse(stdout[0]);
    assert.equal(result.exitCode, 0);
    assert.equal(envelope.workflowId, 'hypotheses');
    assert.equal(envelope.status, 'completed');
    assert.equal(envelope.data.fitness.grade, 'A');
  } finally {
    closeCli(managed);
  }
});
