'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Graph = require('../graph');
const {
  readBudgetState,
  reserveImpact,
  commitReservation,
  releaseReservation,
} = require('../lib/impact-budget-ledger');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-budget-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function memoryGraph(dir) {
  return new Graph({ useSQLite: false, memoryPath: path.join(dir, 'memory.json') });
}

const SCOPE = Object.freeze({
  policyVersion: 'policy-v1',
  workspaceId: 'workspace-a',
  runId: 'run-1',
  sessionId: 'session-1',
});

test('reserve records units and replays the same key without double charge', (t) => {
  const graph = memoryGraph(tempDir(t));
  const first = reserveImpact(graph, { scope: SCOPE, amount: 120, idempotencyKey: 'k1' });
  assert.equal(first.replayed, false);
  assert.equal(first.reservationId, 'res:k1');
  assert.equal(first.reserved, 120);
  const replay = reserveImpact(graph, { scope: SCOPE, amount: 999, idempotencyKey: 'k1' });
  assert.equal(replay.replayed, true);
  assert.deepEqual(readBudgetState(graph, SCOPE), {
    scope: { ...SCOPE },
    reserved: 120,
    committed: 0,
  });
});

test('commit moves reserved to committed, release frees it', (t) => {
  const graph = memoryGraph(tempDir(t));
  reserveImpact(graph, { scope: SCOPE, amount: 120, idempotencyKey: 'k1' });
  reserveImpact(graph, { scope: SCOPE, amount: 30, idempotencyKey: 'k2' });
  const committed = commitReservation(graph, { reservationId: 'res:k1', idempotencyKey: 'c1' });
  assert.equal(committed.replayed, false);
  assert.deepEqual(readBudgetState(graph, SCOPE), {
    scope: { ...SCOPE },
    reserved: 30,
    committed: 120,
  });
  const released = releaseReservation(graph, { reservationId: 'res:k2', idempotencyKey: 'r1' });
  assert.equal(released.kind, 'release');
  assert.deepEqual(readBudgetState(graph, SCOPE), {
    scope: { ...SCOPE },
    reserved: 0,
    committed: 120,
  });
  const replayCommit = commitReservation(graph, { reservationId: 'res:k1', idempotencyKey: 'c1' });
  assert.equal(replayCommit.replayed, true);
});

test('settling unknown or twice-settled reservations fails closed', (t) => {
  const graph = memoryGraph(tempDir(t));
  assert.throws(() => commitReservation(graph, { reservationId: 'res:ghost', idempotencyKey: 'c9' }), /unknown reservation/);
  assert.throws(() => releaseReservation(graph, { reservationId: 'res:ghost', idempotencyKey: 'r9' }), /unknown reservation/);
  reserveImpact(graph, { scope: SCOPE, amount: 10, idempotencyKey: 'k1' });
  commitReservation(graph, { reservationId: 'res:k1', idempotencyKey: 'c1' });
  assert.throws(() => releaseReservation(graph, { reservationId: 'res:k1', idempotencyKey: 'r2' }), /already settled/);
});

test('scopes are isolated by policy, workspace, run and session', (t) => {
  const graph = memoryGraph(tempDir(t));
  reserveImpact(graph, { scope: SCOPE, amount: 50, idempotencyKey: 'k1' });
  const other = readBudgetState(graph, { ...SCOPE, runId: 'run-2' });
  assert.deepEqual([other.reserved, other.committed], [0, 0]);
  const otherPolicy = readBudgetState(graph, { ...SCOPE, policyVersion: 'policy-v2' });
  assert.deepEqual([otherPolicy.reserved, otherPolicy.committed], [0, 0]);
  assert.equal(readBudgetState(graph, SCOPE).reserved, 50);
});

test('state survives reopening the store', (t) => {
  const dir = tempDir(t);
  const first = memoryGraph(dir);
  reserveImpact(first, { scope: SCOPE, amount: 70, idempotencyKey: 'k1' });
  commitReservation(first, { reservationId: 'res:k1', idempotencyKey: 'c1' });
  const second = memoryGraph(dir);
  assert.deepEqual(readBudgetState(second, SCOPE), {
    scope: { ...SCOPE },
    reserved: 0,
    committed: 70,
  });
});

test('malformed calls fail closed without writing rows', (t) => {
  const graph = memoryGraph(tempDir(t));
  assert.throws(() => reserveImpact(null, { scope: SCOPE, amount: 1, idempotencyKey: 'k' }), /graph/);
  assert.throws(() => reserveImpact(graph, { scope: SCOPE, amount: -1, idempotencyKey: 'k' }), /amount/);
  assert.throws(() => reserveImpact(graph, { scope: { workspaceId: 'w' }, amount: 1, idempotencyKey: 'k' }), /policyVersion/);
  assert.throws(() => reserveImpact(graph, { scope: SCOPE, amount: 1, idempotencyKey: '   ' }), /idempotencyKey/);
  assert.deepEqual(readBudgetState(graph, SCOPE), {
    scope: { ...SCOPE },
    reserved: 0,
    committed: 0,
  });
});
