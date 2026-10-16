'use strict';

/**
 * Regression coverage for #412.
 *
 * `id` is a PRIMARY KEY on checkpoints, agent_runs and tool_approvals. The
 * generated fallback ids used to be `${prefix}-${Date.now()}`, so any two
 * records created inside the same millisecond collided.
 *
 * For tool_approvals that is not absorbed by the upsert: ON CONFLICT is
 * declared on approval_key, so two *different* approvals landing on the same
 * id raise SQLITE_CONSTRAINT_PRIMARYKEY rather than updating a row.
 *
 * Each test below pins the clock so every record in it is created within the
 * "same millisecond" -- with the old id scheme these fail, with the current
 * one they pass.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HuqanStorage = require('../storage');

let HAS_SQLITE = true;
try {
  require.resolve('better-sqlite3');
} catch (_) {
  HAS_SQLITE = false;
}

const FROZEN_NOW = 1_700_000_000_000;

function withFrozenClockStore(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-id-collision-'));
  const store = new HuqanStorage({
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
  });
  store._now = () => FROZEN_NOW;
  try {
    return fn(store);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('generated ids are unique within a single millisecond (#412)', { skip: !HAS_SQLITE }, () => {
  withFrozenClockStore((store) => {
    const ids = new Set();
    for (let i = 0; i < 200; i += 1) {
      ids.add(store._newId('approval'));
    }
    assert.equal(ids.size, 200);
    for (const id of ids) {
      assert.match(id, /^approval-1700000000000-[0-9a-f]{12}$/);
    }
  });
});

test('two distinct approvals in the same millisecond both persist (#412)', { skip: !HAS_SQLITE }, () => {
  withFrozenClockStore((store) => {
    // No explicit `id`, so both fall back to the generated one.
    const first = store.saveToolApproval({
      approvalKey: 'http.ingest:payload-a',
      tool: 'http.ingest',
      input: '{"snapshot":"a"}',
    });
    const second = store.saveToolApproval({
      approvalKey: 'http.ingest:payload-b',
      tool: 'http.ingest',
      input: '{"snapshot":"b"}',
    });

    assert.ok(first);
    assert.ok(second);
    assert.notEqual(first.id, second.id);
    assert.equal(store.getToolApprovalByKey('http.ingest:payload-a').input, '{"snapshot":"a"}');
    assert.equal(store.getToolApprovalByKey('http.ingest:payload-b').input, '{"snapshot":"b"}');
  });
});

test('saveToolApprovalIfAbsent does not collide in the same millisecond (#412)', { skip: !HAS_SQLITE }, () => {
  withFrozenClockStore((store) => {
    const a = store.saveToolApprovalIfAbsent({ tool: 'http.ingest', input: 'a' });
    const b = store.saveToolApprovalIfAbsent({ tool: 'http.ingest', input: 'b' });

    assert.equal(a.inserted, true);
    assert.equal(b.inserted, true);
    assert.notEqual(a.approval.id, b.approval.id);
  });
});

test('two distinct checkpoints in the same millisecond both persist (#412)', { skip: !HAS_SQLITE }, () => {
  withFrozenClockStore((store) => {
    store.saveCheckpoint({ goal: 'goal-a', state: { step: 1 } });
    store.saveCheckpoint({ goal: 'goal-b', state: { step: 1 } });

    assert.equal(store.countCheckpoints(), 2);
    assert.ok(store.loadLatestCheckpoint('goal-a'));
    assert.ok(store.loadLatestCheckpoint('goal-b'));
  });
});

test('two distinct runs in the same millisecond both persist (#412)', { skip: !HAS_SQLITE }, () => {
  withFrozenClockStore((store) => {
    store.saveRun({ goal: 'goal-a', status: 'completed' });
    store.saveRun({ goal: 'goal-b', status: 'completed' });

    assert.equal(store.countRuns(), 2);
  });
});
