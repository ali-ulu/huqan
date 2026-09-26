'use strict';

// Characterises the checkpoint/goal-memory/run records #2165 moved out of
// storage.js into lib/storage/run-state-methods.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HuqanStorage = require('../storage');

function withStorage(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-run-state-'));
  const storage = new HuqanStorage({ dbPath: path.join(dir, 'memory.db') });
  try { return fn(storage); } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('run-state methods keep the class-method descriptor after the move', () => {
  const classMethod = Object.getOwnPropertyDescriptor(HuqanStorage.prototype, 'withTransaction');
  for (const name of ['saveCheckpoint', 'loadLatestCheckpoint', 'saveGoalMemory', 'saveRun', 'countRuns']) {
    const moved = Object.getOwnPropertyDescriptor(HuqanStorage.prototype, name);
    assert.equal(typeof moved.value, 'function', name);
    for (const key of ['enumerable', 'writable', 'configurable']) assert.equal(moved[key], classMethod[key], `${name}.${key}`);
  }
});

test('goal memory counts each outcome into its own counter', () => withStorage((storage) => {
  storage.saveGoalMemory({ goal: 'G', workspaceId: 'w', status: 'blocked' });
  storage.saveGoalMemory({ goal: 'G', workspaceId: 'w', status: 'blocked' });
  storage.saveGoalMemory({ goal: 'G', workspaceId: 'w', status: 'completed', resumed: true });
  const memory = storage.getGoalMemory('g', 'w');
  assert.equal(memory.blocked_count, 2);
  assert.equal(memory.success_count, 1);
  assert.equal(memory.error_count, 0);
  assert.equal(memory.resumed_count, 1);
  assert.equal(memory.last_status, 'completed');
  assert.equal(storage.getGoalMemory('g', 'other'), null, 'goal memory is workspace-scoped');
}));

test('a negative iteration delta never reduces the rolling iteration sum', () => withStorage((storage) => {
  storage.saveRun({ goal: 'G', workspaceId: 'w', iterationsDelta: 4 });
  storage.saveRun({ goal: 'G', workspaceId: 'w', iterationsDelta: -5 });
  assert.equal(storage.sumAgentIterationsSince('w', 0), 4);
  assert.equal(storage.countRuns(), 2);
}));
