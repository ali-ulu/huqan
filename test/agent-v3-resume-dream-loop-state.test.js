'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const KernelV2 = require('../kernel.v2');
const AgentV3 = require('../agent.v3');
const Kernel = require('../kernel');

const TEST_FIXTURE_LEARN_BYPASS = Kernel.createAdmissionBypassOpts('test_fixture_seed');

function freshAgent() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-v3-resume-dream-'));
  const kernel = new KernelV2({
    noLoad: true,
    useSQLite: false,
    loadPlugins: false,
    memoryPath: path.join(tmpDir, 'memory.json'),
  });
  kernel.learn('kedi hayvandir', TEST_FIXTURE_LEARN_BYPASS);
  return new AgentV3({
    kernel,
    dbPath: path.join(tmpDir, 'memory.db'),
    maxSteps: 4,
    maxIterations: 50,
    timeBudgetMs: 2000,
    dreamExperimentLoop: false,
  });
}

// #2066: _hydrateState() rehydrated a persisted dream-experiment loop by calling
// ensureState(), but that name was never imported into agent.v3.js — it lives in
// lib/dream-experiment-loop.js and the adapter required on line 9 did not re-export
// it. Any resume whose checkpoint carried a dreamExperimentLoop object therefore
// threw ReferenceError instead of resuming. Only this branch was affected, which is
// why every existing resume test (all of which checkpoint without a loop) stayed
// green.
describe('AgentV3 resume with a persisted dream-experiment loop', () => {
  const activePlan = {
    goal: 'kedi hayvandir mi?',
    objective: 'verify',
    selectedTools: ['verify'],
    steps: [{ id: 's1', action: 'verify', tool: 'verify', input: {} }],
  };

  it('rehydrates dreamExperimentLoop instead of throwing ReferenceError', () => {
    const agent = freshAgent();

    const checkpoint = {
      id: 'ckpt-dream-1',
      budget_remaining: 1500,
      state: {
        goal: activePlan.goal,
        workspaceId: 'default',
        steps: [],
        evidence: [],
        notes: [],
        queuedSteps: [],
        dreamExperimentLoop: {
          experimentId: 'exp-1',
          hypotheses: [],
          cycle: 1,
        },
      },
    };

    const state = agent._hydrateState(activePlan, checkpoint);

    assert.ok(
      state.dreamExperimentLoop && typeof state.dreamExperimentLoop === 'object',
      'resumed state must keep a dream-experiment loop object',
    );
    assert.strictEqual(state.dreamExperimentLoop.experimentId, 'exp-1');
    assert.strictEqual(state.resumed, true);
  });

  it('leaves a checkpoint without a dream-experiment loop untouched', () => {
    const agent = freshAgent();

    const state = agent._hydrateState(activePlan, {
      id: 'ckpt-plain-1',
      budget_remaining: 1500,
      state: { goal: activePlan.goal, steps: [], evidence: [], notes: [], queuedSteps: [] },
    });

    assert.strictEqual(state.dreamExperimentLoop, undefined);
    assert.strictEqual(state.resumed, true);
  });
});
