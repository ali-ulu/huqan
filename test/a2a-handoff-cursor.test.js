'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createA2aHandoffCursor, CURSOR_SCHEMA_VERSION } = require('../lib/a2a/handoff-cursor');
const {
  TERMINATION_SCHEMA_VERSION,
  HANDOFF_TERMINATION_REASONS,
  isTerminationReason,
  resolveHandoffTermination,
} = require('../lib/a2a/handoff-termination');
const { createA2aHandoffDispatcher } = require('../index');

const T0 = '2026-10-06T12:00:00.000Z';
const T1 = '2026-10-06T12:00:01.000Z';
const ROUTE_A = 'a'.repeat(64);
const ROUTE_B = 'b'.repeat(64);

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'huqan-handoff-cursor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, store: () => createA2aHandoffCursor(root) };
}

function cursor(routeReceiptId = ROUTE_A, extra = {}) {
  return {
    from_agent_id: 'agent-source', to_agent_id: 'agent-target',
    route_receipt_id: routeReceiptId, timestamp: T0, ...extra,
  };
}

test('record then read is active, and a restarted store resumes it', t => {
  const s = sandbox(t);
  assert.deepEqual(s.store().recordCursor(cursor()), { recorded: true });
  const live = s.store().readCursor(ROUTE_A);
  assert.equal(live.found, true);
  assert.equal(live.active, true);
  assert.equal(live.cursor.from_agent_id, 'agent-source');
  assert.equal(live.cursor.to_agent_id, 'agent-target');
  assert.equal(live.cursor.route_receipt_id, ROUTE_A);
  // Restart: a fresh instance over the same directory proves resume.
  const restarted = createA2aHandoffCursor(s.root);
  const resumed = restarted.readCursor(ROUTE_A);
  assert.equal(resumed.found, true);
  assert.equal(resumed.active, true);
  assert.deepEqual(resumed.cursor, live.cursor);
});

test('identical re-record is idempotent, a different cursor is a conflict', t => {
  const s = sandbox(t);
  const store = s.store();
  assert.deepEqual(store.recordCursor(cursor()), { recorded: true });
  assert.deepEqual(store.recordCursor(cursor()), { recorded: true, duplicate: true });
  const clash = store.recordCursor(cursor(ROUTE_A, { to_agent_id: 'agent-other' }));
  assert.deepEqual(clash, { recorded: false, reason: 'handoff_identity_conflict' });
  // The first record stands.
  assert.equal(store.readCursor(ROUTE_A).cursor.to_agent_id, 'agent-target');
});

test('human and target closes carry separate termination reasons', t => {
  const s = sandbox(t);
  const store = s.store();
  store.recordCursor(cursor(ROUTE_A));
  store.recordCursor(cursor(ROUTE_B));
  const human = store.closeCursor(ROUTE_A, { handoffReason: 'delegated_task', closedBy: 'human', timestamp: T1 });
  const target = store.closeCursor(ROUTE_B, { handoffReason: 'delegated_task', closedBy: 'target', timestamp: T1 });
  assert.equal(human.closed, true);
  assert.equal(target.closed, true);
  assert.equal(human.termination.termination_reason, HANDOFF_TERMINATION_REASONS.HUMAN_HANDOFF);
  assert.equal(target.termination.termination_reason, HANDOFF_TERMINATION_REASONS.TARGET_COMPLETE);
  assert.notEqual(human.termination.termination_reason, target.termination.termination_reason);
  // A bypass that collapses both closers to one reason cannot pass the above.
  const readBack = s.store().readCursor(ROUTE_A);
  assert.equal(readBack.active, false);
  assert.equal(readBack.termination.termination_reason, 'human_handoff');
  assert.equal(s.store().readCursor(ROUTE_B).termination.termination_reason, 'target_complete');
  // Restarted readers see the same closed state: no phantom resume.
  const restarted = createA2aHandoffCursor(s.root);
  assert.equal(restarted.readCursor(ROUTE_A).active, false);
  assert.equal(restarted.readCursor(ROUTE_B).termination.closed_by, 'target');
});

test('unknown wire reason, unknown closer and malformed closures refuse', t => {
  const s = sandbox(t);
  const store = s.store();
  store.recordCursor(cursor());
  assert.throws(() => store.closeCursor(ROUTE_A,
    { handoffReason: 'escalated_review', closedBy: 'human', timestamp: T1 }), /handoff_reason_unknown/);
  assert.throws(() => store.closeCursor(ROUTE_A,
    { handoffReason: 'delegated_task', closedBy: 'observer', timestamp: T1 }), /handoff_closer_unknown/);
  assert.throws(() => store.closeCursor(ROUTE_A,
    { handoffReason: 'delegated_task', closedBy: 'human', timestamp: 'yesterday' }), /closure is invalid/);
  assert.throws(() => store.closeCursor('not-a-hash',
    { handoffReason: 'delegated_task', closedBy: 'human', timestamp: T1 }), /cursor id is invalid/);
  // Nothing was written by the refusals: still active, no termination file.
  assert.equal(store.readCursor(ROUTE_A).active, true);
  assert.equal(fs.existsSync(path.join(s.root, `${ROUTE_A}.handoff-terminated`)), false);
  // Closing a cursor that was never recorded refuses instead of inventing one.
  assert.deepEqual(store.closeCursor(ROUTE_B,
    { handoffReason: 'delegated_task', closedBy: 'human', timestamp: T1 }),
  { closed: false, reason: 'cursor_not_found' });
});

test('a closed cursor never reopens and a second close keeps the first', t => {
  const s = sandbox(t);
  const store = s.store();
  store.recordCursor(cursor());
  assert.equal(store.closeCursor(ROUTE_A,
    { handoffReason: 'delegated_task', closedBy: 'target', timestamp: T1 }).closed, true);
  assert.deepEqual(store.recordCursor(cursor(ROUTE_A, { timestamp: T1 })),
    { recorded: false, reason: 'cursor_closed' });
  const again = store.closeCursor(ROUTE_A,
    { handoffReason: 'delegated_task', closedBy: 'human', timestamp: T1 });
  assert.equal(again.closed, false);
  assert.equal(again.reason, 'cursor_already_closed');
  assert.equal(again.termination.termination_reason, 'target_complete');
});

test('malformed ids, shapes and corrupt bytes never read as active', t => {
  const s = sandbox(t);
  const store = s.store();
  assert.deepEqual(store.readCursor('not-a-hash'), { found: false });
  assert.deepEqual(store.readCursor(ROUTE_A), { found: false });
  assert.throws(() => store.recordCursor(cursor(ROUTE_A, { to_agent_id: '' })), /cursor is invalid/);
  assert.throws(() => store.recordCursor({ ...cursor(), smuggled: true }), /cursor is invalid/);
  assert.throws(() => store.recordCursor(cursor('z'.repeat(64))), /cursor is invalid/);
  assert.throws(() => store.recordCursor(cursor(ROUTE_A, { timestamp: '2026-10-06' })), /cursor is invalid/);
  store.recordCursor(cursor());
  fs.writeFileSync(path.join(s.root, `${ROUTE_A}.handoff-cursor`), '{broken', 'utf8');
  const corrupt = createA2aHandoffCursor(s.root).readCursor(ROUTE_A);
  assert.equal(corrupt.found, true);
  assert.equal(corrupt.active, false);
  assert.equal(corrupt.corrupt, true);
});

test('records carry exactly the scoped fields and versions', t => {
  const s = sandbox(t);
  const store = s.store();
  store.recordCursor(cursor());
  store.closeCursor(ROUTE_A, { handoffReason: 'delegated_task', closedBy: 'human', timestamp: T1 });
  const cursorFile = JSON.parse(fs.readFileSync(path.join(s.root, `${ROUTE_A}.handoff-cursor`), 'utf8'));
  const terminatedFile = JSON.parse(fs.readFileSync(path.join(s.root, `${ROUTE_A}.handoff-terminated`), 'utf8'));
  assert.deepEqual(Object.keys(cursorFile).sort(),
    ['from_agent_id', 'route_receipt_id', 'schemaVersion', 'timestamp', 'to_agent_id']);
  assert.equal(cursorFile.schemaVersion, CURSOR_SCHEMA_VERSION);
  assert.deepEqual(Object.keys(terminatedFile).sort(),
    ['closed_by', 'handoff_reason', 'route_receipt_id', 'schemaVersion', 'termination_reason', 'timestamp']);
  assert.equal(terminatedFile.schemaVersion, TERMINATION_SCHEMA_VERSION);
});

test('the cursor directory must be a real directory', t => {
  const s = sandbox(t);
  const notDir = path.join(s.root, 'file-not-dir');
  fs.writeFileSync(notDir, 'x', 'utf8');
  assert.throws(() => createA2aHandoffCursor(notDir), /real directory/);
  assert.throws(() => createA2aHandoffCursor(path.join(s.root, 'missing')), /ENOENT/);
});

test('termination allowlist: legacy reason recognized, closers distinct', () => {
  assert.equal(isTerminationReason('human_handoff'), true);
  assert.equal(isTerminationReason('target_complete'), true);
  assert.equal(isTerminationReason('delegated_task'), false);
  assert.equal(isTerminationReason(''), false);
  assert.deepEqual(resolveHandoffTermination({ handoffReason: 'delegated_task', closedBy: 'human' }),
    { handoffReason: 'delegated_task', closedBy: 'human', terminationReason: 'human_handoff' });
  assert.deepEqual(resolveHandoffTermination({ handoffReason: 'delegated_task', closedBy: 'target' }),
    { handoffReason: 'delegated_task', closedBy: 'target', terminationReason: 'target_complete' });
  assert.throws(() => resolveHandoffTermination(null), /must be an object/);
});

test('the public SDK exposes the cursor and termination modules', () => {
  assert.equal(typeof createA2aHandoffDispatcher, 'function');
  const { createA2aHandoffCursor: fromIndex, HANDOFF_TERMINATION_REASONS: reasons } = require('../index');
  assert.equal(typeof fromIndex, 'function');
  assert.equal(reasons.HUMAN_HANDOFF, 'human_handoff');
});
