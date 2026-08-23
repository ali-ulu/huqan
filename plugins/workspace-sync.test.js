const test = require('node:test');
const assert = require('node:assert/strict');

const workspaceSync = require('./workspace-sync');
const { ensureSyncState, resolveRunWorkspaceId, recordRun, MAX_LOG_ENTRIES } = workspaceSync._test;

function fakeKernelWithEmit() {
  const emitted = [];
  return {
    emitted,
    plugins: { emit(event, data) { emitted.push({ event, data }); return data; } },
  };
}

test('workspace-sync: resolveRunWorkspaceId reads state.workspaceId, defaults to "default"', () => {
  assert.equal(resolveRunWorkspaceId({ workspaceId: 'ws-a' }), 'ws-a');
  assert.equal(resolveRunWorkspaceId({}), 'default');
  assert.equal(resolveRunWorkspaceId({ workspaceId: '   ' }), 'default');
});

test('workspace-sync: recordRun does nothing on the first run of a goal (nothing to compare against)', () => {
  const kernel = fakeKernelWithEmit();
  const decision = recordRun(kernel, { goal: 'find x', workspaceId: 'ws-a' });
  assert.equal(decision, null);
  assert.equal(kernel.emitted.length, 0);
  assert.equal(ensureSyncState(kernel).byGoal['find x'].workspaceId, 'ws-a');
});

test('workspace-sync: recordRun does nothing when the same goal reruns in the same workspace', () => {
  const kernel = fakeKernelWithEmit();
  recordRun(kernel, { goal: 'find x', workspaceId: 'ws-a' });
  const decision = recordRun(kernel, { goal: 'find x', workspaceId: 'ws-a' });
  assert.equal(decision, null);
  assert.equal(kernel.emitted.length, 0);
});

test('workspace-sync: recordRun evaluates AB11 and logs when the same goal switches workspace', () => {
  const kernel = fakeKernelWithEmit();
  recordRun(kernel, { goal: 'find x', workspaceId: 'ws-a' });
  const decision = recordRun(kernel, { goal: 'find x', workspaceId: 'ws-b' });

  assert.ok(decision);
  assert.equal(decision.actorWorkspaceId, 'ws-a');
  assert.equal(decision.targetWorkspaceId, 'ws-b');
  assert.equal(kernel.emitted.length, 1);
  assert.equal(kernel.emitted[0].event, 'afterGateDecision');
  assert.equal(kernel.emitted[0].data.source, 'workspace-sync');

  const syncState = ensureSyncState(kernel);
  assert.equal(syncState.log.length, 1);
  assert.equal(syncState.log[0].fromWorkspaceId, 'ws-a');
  assert.equal(syncState.log[0].toWorkspaceId, 'ws-b');
  assert.equal(syncState.byGoal['find x'].workspaceId, 'ws-b', 'the tracked workspace must advance to the new one');
});

test('workspace-sync: independent goals do not cross-contaminate each other\'s tracked workspace', () => {
  const kernel = fakeKernelWithEmit();
  recordRun(kernel, { goal: 'goal A', workspaceId: 'ws-a' });
  recordRun(kernel, { goal: 'goal B', workspaceId: 'ws-b' });
  assert.equal(kernel.emitted.length, 0, 'different goals in different workspaces is not a workspace switch');
});

test('workspace-sync: afterAgentRun hook records into kernel state', () => {
  const kernel = fakeKernelWithEmit();
  workspaceSync.afterAgentRun(kernel, { goal: 'g', workspaceId: 'ws-a' });
  assert.equal(ensureSyncState(kernel).byGoal.g.workspaceId, 'ws-a');
});

test('workspace-sync: run() log and byGoal actions return isolated copies', () => {
  const kernel = fakeKernelWithEmit();
  recordRun(kernel, { goal: 'find x', workspaceId: 'ws-a' });
  recordRun(kernel, { goal: 'find x', workspaceId: 'ws-b' });

  const logResult = workspaceSync.run(kernel, { action: 'log' });
  assert.equal(logResult.ok, true);
  assert.equal(logResult.log.length, 1);

  const byGoalResult = workspaceSync.run(kernel, { action: 'byGoal' });
  assert.equal(byGoalResult.ok, true);
  assert.equal(byGoalResult.byGoal['find x'].workspaceId, 'ws-b');
});

test('workspace-sync: log is capped at MAX_LOG_ENTRIES, dropping the oldest entries', () => {
  const kernel = fakeKernelWithEmit();
  const goal = 'find x';
  for (let i = 0; i < MAX_LOG_ENTRIES + 10; i += 1) {
    recordRun(kernel, { goal, workspaceId: i % 2 === 0 ? 'ws-a' : 'ws-b' });
  }
  const syncState = ensureSyncState(kernel);
  assert.equal(syncState.log.length, MAX_LOG_ENTRIES);
  // The oldest 10 switches were dropped; the newest entry is still the last one recorded.
  assert.equal(syncState.log[syncState.log.length - 1].toWorkspaceId, syncState.byGoal[goal].workspaceId);
});

test('workspace-sync: run() rejects an unsupported action', () => {
  const kernel = fakeKernelWithEmit();
  const result = workspaceSync.run(kernel, { action: 'nonsense' });
  assert.equal(result.ok, false);
});
