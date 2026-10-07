'use strict';

// #3489: a handoff cursor carries the SHA-256 of its free-text handoff
// context (never the text), and the resume decision is bound to it: the same
// text resumes, anything else refuses.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createA2aHandoffCursor,
  CURSOR_SCHEMA_VERSION,
  CONTEXT_CURSOR_SCHEMA_VERSION,
  CURSOR_SUFFIX,
} = require('../lib/a2a/handoff-cursor');

const T0 = '2026-10-07T12:00:00.000Z';
const T1 = '2026-10-07T12:00:01.000Z';
const ROUTE_A = 'a'.repeat(64);
const ROUTE_B = 'b'.repeat(64);
const CONTEXT = 'Customer asked to cancel order 4411; refund already approved by billing.';

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'huqan-handoff-context-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, store: () => createA2aHandoffCursor(root) };
}

function cursor(routeReceiptId = ROUTE_A, extra = {}) {
  return { from_agent_id: 'agent-source', to_agent_id: 'agent-target', route_receipt_id: routeReceiptId, timestamp: T0, ...extra };
}

test('the record carries the context hash and never the text', (t) => {
  const s = sandbox(t);
  assert.deepEqual(s.store().recordCursor(cursor(ROUTE_A, { handoff_context: CONTEXT })), { recorded: true });
  const bytes = fs.readFileSync(path.join(s.root, `${ROUTE_A}${CURSOR_SUFFIX}`), 'utf8');
  assert.ok(!bytes.includes('refund'), 'the free text is not stored');
  const record = JSON.parse(bytes);
  assert.equal(record.schemaVersion, CONTEXT_CURSOR_SCHEMA_VERSION);
  assert.equal(record.handoff_context_hash, crypto.createHash('sha256').update(CONTEXT, 'utf8').digest('hex'));
  // A restarted store reads it back as an active cursor.
  const live = s.store().readCursor(ROUTE_A);
  assert.equal(live.active, true);
  assert.equal(live.cursor.handoff_context_hash, record.handoff_context_hash);
});

test('a resume is decided against the recorded context', (t) => {
  const s = sandbox(t);
  s.store().recordCursor(cursor(ROUTE_A, { handoff_context: CONTEXT }));
  const store = s.store();
  const resumed = store.resumeCursor(ROUTE_A, { handoffContext: CONTEXT });
  assert.equal(resumed.resumable, true);
  assert.equal(resumed.contextBound, true);
  assert.equal(resumed.cursor.to_agent_id, 'agent-target');
  assert.deepEqual(store.resumeCursor(ROUTE_A, { handoffContext: `${CONTEXT} ` }), { resumable: false, reason: 'handoff_context_mismatch' });
  for (const missing of [undefined, '', 42, 'x'.repeat(65537)]) {
    assert.deepEqual(store.resumeCursor(ROUTE_A, { handoffContext: missing }), { resumable: false, reason: 'handoff_context_required' });
  }
  assert.deepEqual(store.resumeCursor(ROUTE_A), { resumable: false, reason: 'handoff_context_required' });
});

test('a cursor without recorded context resumes only without one', (t) => {
  const s = sandbox(t);
  s.store().recordCursor(cursor(ROUTE_A));
  const record = JSON.parse(fs.readFileSync(path.join(s.root, `${ROUTE_A}${CURSOR_SUFFIX}`), 'utf8'));
  assert.equal(record.schemaVersion, CURSOR_SCHEMA_VERSION, 'unchanged v1 record');
  const store = s.store();
  const resumed = store.resumeCursor(ROUTE_A);
  assert.equal(resumed.resumable, true);
  assert.equal(resumed.contextBound, false);
  assert.deepEqual(store.resumeCursor(ROUTE_A, { handoffContext: CONTEXT }), { resumable: false, reason: 'handoff_context_unrecorded' });
});

test('missing, closed and corrupt cursors never resume', (t) => {
  const s = sandbox(t);
  const store = s.store();
  assert.deepEqual(store.resumeCursor(ROUTE_A, { handoffContext: CONTEXT }), { resumable: false, reason: 'cursor_not_found' });
  store.recordCursor(cursor(ROUTE_A, { handoff_context: CONTEXT }));
  store.closeCursor(ROUTE_A, { handoffReason: 'delegated_task', closedBy: 'human', timestamp: T1 });
  const closed = store.resumeCursor(ROUTE_A, { handoffContext: CONTEXT });
  assert.equal(closed.resumable, false);
  assert.equal(closed.reason, 'cursor_closed');
  fs.writeFileSync(path.join(s.root, `${ROUTE_B}${CURSOR_SUFFIX}`), '{"schemaVersion":"v5-a2a-handoff-cursor-v2"}');
  assert.deepEqual(store.resumeCursor(ROUTE_B, { handoffContext: CONTEXT }), { resumable: false, reason: 'cursor_corrupt' });
});

test('the context is bounded and shape-checked, and re-recording stays idempotent', (t) => {
  const s = sandbox(t);
  const store = s.store();
  for (const bad of ['', 7, null, 'x'.repeat(65537)]) {
    assert.throws(() => store.recordCursor(cursor(ROUTE_A, { handoff_context: bad })), /invalid/);
  }
  assert.throws(() => store.recordCursor(cursor(ROUTE_A, { handoff_context_hash: 'f'.repeat(64) })), /invalid/,
    'a caller cannot supply the hash');
  assert.deepEqual(store.recordCursor(cursor(ROUTE_A, { handoff_context: CONTEXT })), { recorded: true });
  assert.deepEqual(store.recordCursor(cursor(ROUTE_A, { handoff_context: CONTEXT })), { recorded: true, duplicate: true });
  assert.deepEqual(store.recordCursor(cursor(ROUTE_A, { handoff_context: 'another story' })),
    { recorded: false, reason: 'handoff_identity_conflict' });
});
