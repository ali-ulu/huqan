'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const HuqanStorage = require('../../storage');
const { spawnFixture, tempDir, waitForExit, waitForLine } = require('./helpers');

test('approval recorded then process kill persists the claim and recovery fails it closed', async (t) => {
  const root = tempDir(t, 'huqan-fault-approval-');
  const dbPath = path.join(root, 'memory.db');
  const child = spawnFixture('approval-kill-child.cjs', [dbPath]);
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });

  await waitForLine(child);
  assert.equal(child.kill('SIGKILL'), true);
  await waitForExit(child);

  const store = new HuqanStorage({
    dbPath,
    memoryPath: path.join(root, 'memory.json'),
  });
  try {
    const persisted = store.getToolApprovalById('fault-approval', 'default');
    assert.equal(persisted.status, 'executing');
    assert.equal(store.claimToolApproval('fault-approval', 'retry', 'default').claimed, false);

    const recovered = store.recoverStuckLeaselessToolApprovals({
      tool: 'huqan.agent',
      now: Date.now() + 180_000,
      maxAgeMs: 1_000,
    });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].status, 'failed');
    assert.equal(recovered[0].decision, 'execution_outcome_unknown');
    assert.match(recovered[0].reason, /stuck_leaseless_execution/);
    assert.equal(store.claimToolApproval('fault-approval', 'retry-after-recovery', 'default').claimed, false);
  } finally {
    store.close();
  }
});
