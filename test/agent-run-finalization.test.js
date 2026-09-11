'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Storage = require('../storage');
const { finalizeAgentRun } = require('../lib/agent-run-finalization');

function fixture(t, status = 'completed') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-finalize-'));
  const dbPath = path.join(dir, 'memory.db');
  const storage = new Storage({ dbPath });
  t.after(() => { storage.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const state = {
    runId: 'run-1', goal: 'goal', workspaceId: 'w', checkpointId: 'cp-1',
    status, iteration: 2, iterationsDelta: 2, completedSteps: 2,
  };
  storage.saveCheckpoint({ ...state, id: 'cp-1', status: 'paused', state: { ...state, status: 'paused' } });
  const input = {
    storage, state, goalMemory: state,
    saveCheckpoint: current => storage.saveCheckpoint({ ...current, id: 'cp-1', state: current }),
  };
  return { storage, state, input, dbPath };
}

for (const [operation, status] of [
  ['saveRun', 'completed'], ['saveGoalMemory', 'completed'],
  ['deleteCheckpoint', 'completed'], ['saveCheckpoint', 'paused'],
]) {
  test(`failure after ${operation} preserves budget without publishing completion`, t => {
    const { storage, input } = fixture(t, status);
    const original = storage[operation].bind(storage);
    const error = new Error('injected write failure');
    storage[operation] = (...args) => { original(...args); throw error; };
    const result = finalizeAgentRun(input);
    assert.equal(result.ok, false);
    assert.equal(result.operation, operation);
    assert.equal(result.error, error);
    assert.equal(storage.countRuns(), 1);
    assert.equal(storage.db.prepare('SELECT status FROM agent_runs').get().status, 'finalizing');
    assert.equal(storage.getGoalMemory('goal', 'w'), null);
    assert.equal(storage.loadCheckpoint('cp-1', 'goal', 'w').state.status, 'paused');
    assert.equal(storage.sumAgentIterationsSince('w', 0), 2);
    storage[operation] = original;
    assert.equal(finalizeAgentRun(input).ok, true);
    assert.equal(storage.countRuns(), 1);
    assert.equal(storage.sumAgentIterationsSince('w', 0), 2);
    assert.equal(storage.getGoalMemory('goal', 'w').success_count, status === 'completed' ? 1 : 0);
  });
}

for (const status of ['completed', 'blocked', 'paused']) {
  test(`${status} commits the corresponding checkpoint state`, t => {
    const { storage, input } = fixture(t, status);
    assert.equal(finalizeAgentRun(input).ok, true);
    assert.equal(storage.countRuns(), 1);
    assert.equal(storage.getGoalMemory('goal', 'w').last_status, status);
    const checkpoint = storage.loadCheckpoint('cp-1', 'goal', 'w');
    if (status === 'paused') assert.equal(checkpoint.state.status, 'paused');
    else assert.equal(checkpoint, null);
    assert.equal(storage.getGoalMemory('goal', 'other'), null);
  });
}

test('legacy injected storage retains ordered calls and error identity', () => {
  const calls = [];
  const error = new Error('denied');
  const result = finalizeAgentRun({
    storage: {
      saveRun: () => calls.push('run'),
      saveGoalMemory: () => { calls.push('goal'); throw error; },
      deleteCheckpoint: () => calls.push('delete'),
    },
    state: { status: 'completed' }, goalMemory: {},
  });
  assert.deepEqual(calls, ['run', 'goal']);
  assert.equal(result.error, error);
  assert.equal(result.operation, 'saveGoalMemory');
});

for (const operation of ['saveRun', 'saveGoalMemory', 'deleteCheckpoint']) {
  test(`process termination after ${operation} preserves the previous durable state`, t => {
    const { storage, state, dbPath } = fixture(t);
    const script = `
      const Storage = require('./storage');
      const { finalizeAgentRun } = require('./lib/agent-run-finalization');
      const [dbPath, raw, operation] = process.argv.slice(1);
      const storage = new Storage({ dbPath });
      const state = JSON.parse(raw);
      const original = storage[operation].bind(storage);
      storage[operation] = (...args) => {
        original(...args);
        require('node:fs').writeSync(1, 'fault-reached');
        process.kill(process.pid, 'SIGKILL');
      };
      finalizeAgentRun({ storage, state, goalMemory: state });
    `;
    const child = spawnSync(process.execPath, ['-e', script, dbPath, JSON.stringify(state), operation], {
      cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 10000,
    });
    assert.equal(child.error, undefined);
    assert.match(child.stdout, /fault-reached/);
    assert.notEqual(child.status, 0);
    assert.equal(storage.countRuns(), 1);
    assert.equal(storage.db.prepare('SELECT status FROM agent_runs').get().status, 'finalizing');
    assert.equal(storage.sumAgentIterationsSince('w', 0), 2);
    assert.equal(storage.getGoalMemory('goal', 'w'), null);
    assert.ok(storage.loadCheckpoint('cp-1', 'goal', 'w'));
  });
}
