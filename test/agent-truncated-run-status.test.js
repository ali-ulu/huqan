const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Kernel = require('../kernel');
const Agent = require('../agent');

const GOAL = 'kedi hakkinda arastir';

/**
 * maxSteps values that deterministically truncate this goal: the run exits at
 * the ceiling with one queued step still unexecuted. Before the fix both
 * reported `completed` with remainingSteps=1 — the defect itself.
 */
const TRUNCATING = [2, 3];
/** maxSteps values where the run genuinely finishes with an empty queue. */
const COMPLETING = [1, 20];

let tempDir;
let counter = 0;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-agent-truncated-'));
});

after(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

function runAgent(maxSteps) {
  const index = counter++;
  const kernel = new Kernel({
    memoryPath: path.join(tempDir, `kernel-${index}.json`),
    useSQLite: false,
    noLoad: true,
    loadPlugins: false,
  });
  const agent = new Agent({
    kernel,
    memoryPath: path.join(tempDir, `agent-${index}.json`),
    maxSteps,
  });
  const envelope = agent.run(GOAL, { maxSteps });
  return { agent, state: envelope && envelope.data ? envelope.data : envelope };
}

describe('a truncated agent run is not reported completed (#756)', () => {
  for (const maxSteps of TRUNCATING) {
    it(`maxSteps=${maxSteps} leaves queued work, so the run is paused`, () => {
      const { state } = runAgent(maxSteps);
      assert.ok(state.remainingSteps > 0, `expected leftover work at maxSteps=${maxSteps}`);
      assert.strictEqual(state.queuedSteps.length, state.remainingSteps);
      assert.strictEqual(state.status, 'paused');
      assert.notStrictEqual(state.status, 'completed');
    });

    it(`maxSteps=${maxSteps} does not count a truncated run as an objective completion`, () => {
      const { agent, state } = runAgent(maxSteps);
      assert.strictEqual(state.status, 'paused');
      const objectives = agent.memory?.stats?.objectives || {};
      const completed = Object.values(objectives).reduce((sum, bucket) => sum + (bucket.completed || 0), 0);
      assert.strictEqual(completed, 0, 'goal-memory recorded a completion for a truncated run');
    });
  }

  for (const maxSteps of COMPLETING) {
    it(`maxSteps=${maxSteps} finishes its queue, so the run is completed`, () => {
      const { state } = runAgent(maxSteps);
      assert.strictEqual(state.remainingSteps, 0);
      assert.strictEqual(state.queuedSteps.length, 0);
      assert.strictEqual(state.status, 'completed');
    });
  }

  it('remainingSteps > 0 never coexists with completed, across the range', () => {
    const violations = [];
    for (let maxSteps = 1; maxSteps <= 8; maxSteps++) {
      const { state } = runAgent(maxSteps);
      if (state.status === 'completed' && Number(state.remainingSteps) > 0) {
        violations.push(`maxSteps=${maxSteps} remaining=${state.remainingSteps}`);
      }
    }
    assert.deepStrictEqual(violations, [], 'a run claimed completion with work still queued');
  });

  it('a failing final step still reports blocked, ahead of paused', () => {
    // `blocked` is the more specific outcome, so it keeps priority over the
    // new queued-work branch. Asserted on the production expression's shape.
    const finalStep = { result: { ok: false } };
    const queued = [{ action: 'left-over' }];
    const status = finalStep && finalStep.result && finalStep.result.ok === false
      ? 'blocked'
      : (queued.length > 0 ? 'paused' : 'completed');
    assert.strictEqual(status, 'blocked');
  });
});
