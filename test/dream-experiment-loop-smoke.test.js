'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Kernel = require('../kernel');
const KernelV2 = require('../kernel.v2');
const AgentV3 = require('../agent.v3');

const BYPASS = Kernel.createAdmissionBypassOpts('dream-experiment-loop-smoke');

test('AgentV3 opt-in Dream loop generates and verifies a bounded hypothesis cycle', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-dream-loop-smoke-'));
  const trustPolicyPath = path.join(tmpDir, 'trust-policy.json');
  fs.writeFileSync(trustPolicyPath, JSON.stringify({
    version: 'dream-loop-test-policy-v1',
    defaults: { background_inference: 0.6 },
    fallback: { unknown: 0.5 },
  }));
  const kernel = new KernelV2({
    noLoad: true,
    useSQLite: false,
    loadPlugins: false,
    memoryPath: path.join(tmpDir, 'graph-memory.json'),
    trustPolicyPath,
  });
  kernel.learn('kedi hayvandir', BYPASS);
  kernel.graph.addEdge('kedi', 'hayvan', 'tür', { workspaceId: 'default', source: 'test-fixture' });
  const agent = new AgentV3({
    kernel,
    dbPath: path.join(tmpDir, 'memory.db'),
    maxSteps: 4,
    maxIterations: 8,
    timeBudgetMs: 5000,
  });

  const result = agent.run('kedi hayvandir mi?', {
    resume: false,
    workspaceId: 'default',
    maxIterations: 4,
    timeBudgetMs: 5000,
    dreamExperimentLoop: true,
    dreamExperimentMaxHypotheses: 1,
    dreamExperimentMaxCycles: 1,
    dreamExperimentAdmissionOpts: { approvalRequired: false },
  });

  assert.equal(result.ok, true, result.error?.message);
  assert.ok(result.data.dreamExperimentLoop);
  assert.equal(result.data.dreamExperimentLoop.version, 'DEL-v1.0.0');
  assert.ok(result.data.dreamExperimentLoop.transitionSeq >= 1);
  assert.ok(result.data.steps.some(step => step.action === 'dream'));
  assert.ok(result.data.steps.some(step => step.action === 'dream-experiment-verify'));
  assert.equal(result.data.dreamExperimentLoop.observations[0].commitDecision, 'allow');
  assert.ok(kernel.graph.getEdges('hayvan', 'default').some(edge => edge.to === 'kedi' && edge.relation === 'tür'));
});
