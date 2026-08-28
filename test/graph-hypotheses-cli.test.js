'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const CLI = require('../cli');
const Kernel = require('../kernel');
const { isolatedKernelOptions } = require('./helpers/isolated-persistence');
const { runCliArgv } = require('../lib/cli-workflow-adapter');

function createCli(label = 'cli-hypotheses') {
  const kernel = new Kernel(isolatedKernelOptions(label));
  const cli = new CLI({ kernelInstance: kernel });
  return { kernel, cli };
}

function closeCli({ kernel, cli }) {
  cli?.agent?.storage?.close?.();
  kernel?.graph?.close?.();
  kernel?.memory?.close?.();
}

function seedCriticalNode(kernel) {
  for (const id of ['a', 'b', 'c']) kernel.graph.addNode(id, id);
  kernel.graph.addEdge('a', 'b', 'supports', { confidence: 0.9, evidence: ['a'] });
  kernel.graph.addEdge('c', 'b', 'supports', { confidence: 0.9, evidence: ['c'] });
}

test('hypotheses command parses bounded flags and emits a JSON workflow envelope', async () => {
  const managed = createCli('cli-json');
  try {
    seedCriticalNode(managed.kernel);
    const stdout = [];
    const result = await runCliArgv(['hypotheses', '--critical', '2', '--json'], {
      cli: managed.cli,
      stdout: value => stdout.push(value),
    });
    const envelope = JSON.parse(stdout[0]);
    assert.equal(result.workflowId, 'hypotheses');
    assert.equal(result.exitCode, 0);
    assert.equal(envelope.workflowId, 'hypotheses');
    assert.equal(envelope.status, 'completed');
    assert.equal(envelope.data.meta.criticalInDegree, 2);
    assert.equal(envelope.data.hypotheses.some(item => item.type === 'KRİTİK_DÜĞÜM' && item.target === 'b'), true);
  } finally {
    closeCli(managed);
  }
});

test('hypotheses --propose routes high-severity results through candidate admission', async () => {
  const managed = createCli('cli-propose');
  try {
    seedCriticalNode(managed.kernel);
    const stdout = [];
    const result = await runCliArgv(['hypotheses', '--critical', '2', '--propose', '--json'], {
      cli: managed.cli,
      stdout: value => stdout.push(value),
    });
    const envelope = JSON.parse(stdout[0]);
    const candidates = managed.kernel.getCandidateClaims({ workspaceId: 'default' });
    assert.equal(result.exitCode, 0);
    assert.equal(envelope.status, 'completed');
    assert.equal(envelope.data.proposal.queued, 1);
    assert.equal(candidates.length, 1);
    assert.match(candidates[0].claim, /KRİTİK_DÜĞÜM/);
    assert.equal(candidates[0].recommendation, 'flag');
  } finally {
    closeCli(managed);
  }
});
