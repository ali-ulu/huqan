'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { recordRepairClosure, readRepairClosures, closuresForTarget } = require('../lib/cognition-repair-events');

function fakeGraph() {
  const rows = [];
  return {
    rows,
    runMutationOnce(operationId, produce) {
      const result = produce();
      rows.push({ operationId, result, committedAt: new Date().toISOString() });
      return result;
    },
    getCommittedMutationResultsByPrefix(prefix = '') {
      return rows.filter((row) => row.operationId.startsWith(prefix));
    },
  };
}
const closure = (extra = {}) => ({ repairId: 'r_1', targetDecisionId: 'd_fail', workspaceId: 'ws_1',
  executorRef: 'agent:1', verifierRef: 'kernel-observation', outcome: 'confirmed',
  at: '2026-10-31T10:00:00Z', ...extra });

test('a confirmed closure is appended and read back per target', () => {
  const graph = fakeGraph();
  const record = recordRepairClosure(graph, closure());
  assert.equal(record.replayed, false);
  assert.equal(record.outcome, 'confirmed');
  assert.equal(graph.rows[0].operationId, 'cognition-repair:closure:r_1');
  assert.equal(readRepairClosures(graph).length, 1);
  assert.deepEqual(closuresForTarget(graph, 'd_fail').map((row) => row.repairId), ['r_1']);
  assert.deepEqual(closuresForTarget(graph, 'd_other'), []);
});

test('the same repairId replays its record instead of duplicating it', () => {
  const graph = fakeGraph();
  recordRepairClosure(graph, closure());
  const replay = recordRepairClosure(graph, closure());
  assert.equal(replay.replayed, true);
  assert.equal(graph.rows.length, 1);
});

test('a conflicting reuse of the repairId fails closed', () => {
  const graph = fakeGraph();
  recordRepairClosure(graph, closure());
  assert.throws(() => recordRepairClosure(graph, closure({ targetDecisionId: 'd_other' })), /closure conflict/);
});

test('only confirmed closures with an independent verifier are recorded', () => {
  const graph = fakeGraph();
  assert.throws(() => recordRepairClosure(graph, closure({ outcome: 'contradiction' })), /only a confirmed/);
  assert.throws(() => recordRepairClosure(graph, closure({ verifierRef: 'agent:1' })), /verifier must differ/);
  assert.throws(() => recordRepairClosure(graph, closure({ repairId: '' })), /repairId/);
  assert.throws(() => recordRepairClosure(graph, closure({ at: '2026-10-31T10:00:00' })), /at must be a valid instant/);
  assert.throws(() => recordRepairClosure(null, closure()), /graph with runMutationOnce/);
});

test('malformed and foreign journal rows are ignored, not repaired', () => {
  const graph = fakeGraph();
  graph.rows.push({ operationId: 'cognition-repair:closure:bad', result: { repairClosure: true, storeVersion: 'other' } });
  graph.rows.push({ operationId: 'cognition-repair:closure:junk', result: { repairClosure: 'yes' } });
  recordRepairClosure(graph, closure());
  const events = readRepairClosures(graph);
  assert.deepEqual(events.map((row) => row.repairId), ['r_1']);
  assert.ok(Object.isFrozen(events));
});
