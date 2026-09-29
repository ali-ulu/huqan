'use strict';

/**
 * AgentV3 resume against the real checkpoint store.
 *
 * `saveRunCheckpoint` stores a record whose run state sits under `state`, and
 * HuqanStorage keeps the whole record in `state_json`. The resume contract
 * tests inject a store that returns the run state directly, so none of them
 * saw that the production shape is nested one level down -- and resume read
 * the record instead: no completed steps, the plan queued again from the
 * start, and a new run identity each time. These cases go through
 * HuqanStorage so the shape under test is the one production writes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KernelV2 = require('../kernel.v2');
const HuqanStorage = require('../storage');
const { createAgent } = require('../agentRuntime');
const { hydrateRunState } = require('../lib/agent-v3-run-state');

const GOAL = 'answer two questions across a pause';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-v3-resume-'));
  const storage = new HuqanStorage({ dbPath: path.join(dir, 'resume.db') });
  const kernel = new KernelV2({ noLoad: true, useSQLite: false, loadPlugins: false, memoryPath: path.join(dir, 'graph-memory.json') });
  const asked = [];
  kernel.ask = (input) => {
    asked.push(input);
    return { ok: true, type: 'ask', data: { summary: `answered ${input}` }, evidence: [] };
  };
  const makeAgent = () => {
    const agent = createAgent({ kernel, storage, maxSteps: 2, timeBudgetMs: 5000, dreamExperimentLoop: false, experienceJournal: null });
    agent.baseAgent.plan = (goal) => ({
      ok: true,
      type: 'plan',
      data: {
        goal,
        objective: 'answer both',
        selectedTools: ['ask'],
        steps: [
          { id: 's1', action: 'ask', tool: 'ask', input: 'first' },
          { id: 's2', action: 'ask', tool: 'ask', input: 'second' },
        ],
        maxSteps: 2,
      },
    });
    return agent;
  };
  return {
    asked,
    makeAgent,
    storage,
    cleanup() {
      storage.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('a paused run resumes where it stopped, with the same identity (HuqanStorage)', () => {
  const env = setup();
  try {
    const paused = env.makeAgent().run(GOAL, { maxIterations: 1 });
    assert.equal(paused.data.status, 'paused', JSON.stringify(paused.error));
    assert.deepEqual(env.asked, ['first']);
    const runId = paused.data.observabilityRunId;
    assert.ok(runId);

    // maxIterations counts the whole run, resumed iterations included.
    const resumed = env.makeAgent().run(GOAL, { maxIterations: 2 });
    assert.equal(resumed.ok, true, JSON.stringify(resumed.error));
    assert.equal(resumed.data.resumed, true);
    assert.deepEqual(env.asked, ['first', 'second'], 'the completed step must not run again');
    assert.deepEqual(resumed.data.steps.map((step) => step.id), ['s1', 's2'], 'the resumed run keeps the steps already done');
    assert.equal(resumed.data.observabilityRunId, runId, 'a resume is the same run, not a new one');
    assert.equal(resumed.data.status, 'completed');
  } finally {
    env.cleanup();
  }
});

test('a run that stopped in finalization resumes without running its steps again (HuqanStorage)', () => {
  const env = setup();
  try {
    const original = env.storage.saveGoalMemory.bind(env.storage);
    env.storage.saveGoalMemory = () => { throw new Error('injected goal-memory failure'); };
    const failed = env.makeAgent().run(GOAL);
    assert.equal(failed.error.code, 'AGENT_STORAGE_ERROR');
    assert.deepEqual(env.asked, ['first', 'second']);
    env.storage.saveGoalMemory = original;

    const resumed = env.makeAgent().run(GOAL);
    assert.equal(resumed.ok, true, JSON.stringify(resumed.error));
    assert.equal(resumed.data.resumed, true);
    assert.deepEqual(env.asked, ['first', 'second'], 'finishing finalization must not repeat finished steps');
    assert.equal(resumed.data.iterationsDelta, 0, 'a resume with nothing left to run spends no iteration');
    assert.equal(resumed.data.status, 'completed');
  } finally {
    env.cleanup();
  }
});

test('hydrateRunState reads the run state from both checkpoint shapes', () => {
  const plan = { goal: GOAL, objective: 'answer both', selectedTools: ['ask'], steps: [] };
  const runState = { goal: GOAL, steps: [{ id: 's1' }], queuedSteps: [{ id: 's2' }], observabilityRunId: 'run-a', iteration: 1 };
  // HuqanStorage: the record is stored whole, so the run state is nested.
  const fromStorage = hydrateRunState(plan, { id: 'cp-1', state: { checkpointId: 'cp-1', goal: GOAL, iteration: 1, state: runState } });
  // An injected store that returns the run state directly.
  const direct = hydrateRunState(plan, { id: 'cp-1', state: runState });
  for (const state of [fromStorage, direct]) {
    assert.deepEqual(state.steps, [{ id: 's1' }]);
    assert.deepEqual(state.queuedSteps, [{ id: 's2' }]);
    assert.equal(state.observabilityRunId, 'run-a');
    assert.equal(state.resumedFrom, 'cp-1');
  }
  assert.notEqual(fromStorage.steps, runState.steps, 'hydration must copy, not alias, the stored state');
});
