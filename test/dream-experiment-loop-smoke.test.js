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

// #1297: os.tmpdir() is no longer a default-allowed lib/trust-policy.js
// root. This fixture's trustPolicyPath lives under tmpDir, so it must grant
// that one directory via the operator-controlled TRUST_POLICY_ROOTS
// extension mechanism -- the same pattern lib/trust-policy.test.js and
// plugins/policy-watchdog.test.js use.
function withPolicyRoot(root, fn) {
  const previous = process.env.HUQAN_TRUST_POLICY_ROOTS;
  process.env.HUQAN_TRUST_POLICY_ROOTS = root;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.HUQAN_TRUST_POLICY_ROOTS;
    else process.env.HUQAN_TRUST_POLICY_ROOTS = previous;
  }
}

test('AgentV3 opt-in Dream loop generates and verifies a bounded hypothesis cycle', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-dream-loop-smoke-'));
  withPolicyRoot(tmpDir, () => {
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
    // #1213: this fixture used to rely on dream() proposing the reverse of a
    // `tür` edge (hayvan --tür--> kedi). That hypothesis is invalid -- `tür` is
    // not symmetric, and committing its reverse builds the two-node cycle
    // verify reports as a `döngü` contradiction -- so it is no longer
    // generated. `benzer` is symmetric, so it gives this loop the same shape
    // of hypothesis without asserting a semantic the system rejects.
    kernel.graph.addNode('kopek', 'kopek', null, { workspaceId: 'default' });
    kernel.graph.addEdge('kedi', 'kopek', 'benzer', { workspaceId: 'default', source: 'test-fixture', strength: 0.9, confidence: 0.9 });
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
    assert.ok(kernel.graph.getEdges('kopek', 'default').some(edge => edge.to === 'kedi' && edge.relation === 'benzer'));
  });
});
