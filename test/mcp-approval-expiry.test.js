'use strict';

// #3486 (R31) Unit A: a pending MCP approval is not approvable forever.
//
// The expiry instant is stamped on the row at save time, enforced at decision
// time, and derived from createdAt + TTL for rows written before this change
// so an old pending row cannot stay approvable indefinitely.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MCP_APPROVAL_TTL_ENV,
  MIN_MCP_APPROVAL_TTL_MS,
  MAX_MCP_APPROVAL_TTL_MS,
  resolveMcpApprovalTtlMs,
  mcpApprovalExpiresAt,
  isMcpApprovalExpired,
} = require('../lib/mcp-approval-expiry');
const { saveMcpApproval } = require('../lib/mcp-approval-store');
const { createMcpApprovalDecisionHandler } = require('../lib/mcp-approval-decision-handler');
const { DEFAULT_CASE_LIFETIME_MS } = require('../lib/human-oversight-approval-runtime-primitives-values');

const fail = (code, message, extra = {}) => ({ ok: false, error: { code, message }, ...extra });

// --- TTL resolution -------------------------------------------------------

test('the default pending-approval lifetime matches the Human Oversight case lifetime', () => {
  assert.equal(resolveMcpApprovalTtlMs(() => undefined), DEFAULT_CASE_LIFETIME_MS);
  assert.equal(DEFAULT_CASE_LIFETIME_MS, 15 * 60 * 1000);
});

test('the lifetime is configurable through the compat env suffix and cannot be switched off', () => {
  assert.equal(resolveMcpApprovalTtlMs((key) => (key === MCP_APPROVAL_TTL_ENV ? '120000' : undefined)), 120_000);
  // An explicit "never" (0) or a negative value is refused, not clamped: there
  // is no configuration that restores the unbounded row this change removes.
  assert.throws(() => resolveMcpApprovalTtlMs(() => '0'), (error) => error.code === 'HUQAN_MCP_APPROVAL_TTL_INVALID');
  assert.throws(() => resolveMcpApprovalTtlMs(() => '-1'), (error) => error.code === 'HUQAN_MCP_APPROVAL_TTL_INVALID');
  assert.throws(() => resolveMcpApprovalTtlMs(() => String(MIN_MCP_APPROVAL_TTL_MS - 1)), (error) => error.code === 'HUQAN_MCP_APPROVAL_TTL_INVALID');
  assert.throws(() => resolveMcpApprovalTtlMs(() => String(MAX_MCP_APPROVAL_TTL_MS + 1)), (error) => error.code === 'HUQAN_MCP_APPROVAL_TTL_INVALID');
  assert.throws(() => resolveMcpApprovalTtlMs(() => 'soon'), (error) => error.code === 'HUQAN_MCP_APPROVAL_TTL_INVALID');
});

test('the expiry instant is measured from createdAt, and an unparseable createdAt yields no instant', () => {
  assert.equal(mcpApprovalExpiresAt('2026-10-07T00:00:00.000Z', 60_000), '2026-10-07T00:01:00.000Z');
  assert.equal(mcpApprovalExpiresAt(Date.parse('2026-10-07T00:00:00.000Z'), 60_000), '2026-10-07T00:01:00.000Z');
  assert.equal(mcpApprovalExpiresAt('not-a-date', 60_000), null);
  assert.equal(mcpApprovalExpiresAt('2026-10-07T00:00:00.000Z', 0), null);
});

test('expiry prefers an explicit expiresAt and derives from createdAt when it is absent', () => {
  const now = Date.parse('2026-10-07T00:05:00.000Z');
  // Explicit expiresAt in the past / future.
  assert.equal(isMcpApprovalExpired({ expiresAt: '2026-10-07T00:04:59.000Z', createdAt: 0, ttlMs: 60_000, nowMs: now }), true);
  assert.equal(isMcpApprovalExpired({ expiresAt: '2026-10-07T00:05:01.000Z', createdAt: 0, ttlMs: 60_000, nowMs: now }), false);
  // Legacy row: no expiresAt, createdAt + TTL decides.
  assert.equal(isMcpApprovalExpired({ createdAt: Date.parse('2026-10-07T00:03:00.000Z'), ttlMs: 60_000, nowMs: now }), true);
  assert.equal(isMcpApprovalExpired({ createdAt: Date.parse('2026-10-07T00:04:30.000Z'), ttlMs: 60_000, nowMs: now }), false);
  // A malformed explicit expiry fails closed rather than reading as "never".
  assert.equal(isMcpApprovalExpired({ expiresAt: 'garbage', createdAt: now, ttlMs: 60_000, nowMs: now }), true);
});

// --- save-time stamping ---------------------------------------------------

function capturingStore() {
  const saved = [];
  return {
    saved,
    saveToolApproval(record) { saved.push(record); return record; },
  };
}

test('saveMcpApproval stamps context.expiresAt on a new pending approval', () => {
  const store = capturingStore();
  const result = saveMcpApproval(store, 'huqan.ask', { question: 'hello' }, { reason: 'review', decision: 'review' });
  assert.equal(result.persisted, true);
  const expiresAt = result.context.expiresAt;
  assert.equal(typeof expiresAt, 'string');
  assert.ok(Number.isFinite(Date.parse(expiresAt)), 'expiresAt must be a parseable instant');
  // The instant sits one TTL after createdAt.
  assert.equal(Date.parse(expiresAt), result.createdAt + DEFAULT_CASE_LIFETIME_MS);
});

test('the stamped lifetime honours the configured TTL', () => {
  const store = capturingStore();
  const result = saveMcpApproval(
    store,
    'huqan.ask',
    { question: 'hello' },
    { reason: 'review', decision: 'review' },
    { readEnvironment: (key) => (key === MCP_APPROVAL_TTL_ENV ? '60000' : undefined) },
  );
  assert.equal(Date.parse(result.context.expiresAt), result.createdAt + 60_000);
});

// --- decision-time enforcement -------------------------------------------

function pendingRow({ id = 'a1', createdMs = Date.now(), context = {} } = {}) {
  return {
    id,
    approval_key: `mcp.huqan.ask.${id}`,
    tool: 'huqan.ask',
    input: JSON.stringify({ question: 'hello' }),
    workspace_id: 'default',
    status: 'pending',
    decision: 'review',
    reason: 'review',
    created_at: createdMs,
    updated_at: createdMs,
    context: { workspaceId: 'default', args: { question: 'hello' }, ...context },
  };
}

function storeWith(row) {
  return {
    getToolApprovalById: () => row,
    claimToolApproval: () => ({ claimed: false, approval: row }),
    rejectToolApproval: () => ({ rejected: false, approval: row }),
    failToolApproval: () => ({ failed: false, approval: row }),
    finalizeToolApprovalWithReceipt: () => ({ finalized: false, approval: row }),
  };
}

test('an expired pending approval is refused at decision time with a blocked_action_receipt', () => {
  const handle = createMcpApprovalDecisionHandler({ failApprovalDecision: fail });
  const row = pendingRow({ createdMs: Date.now() - (DEFAULT_CASE_LIFETIME_MS + 1000) });
  const result = handle({}, { approvalId: 'a1', workspaceId: 'default', decision: 'approved' }, { approvalStore: storeWith(row) });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'APPROVAL_EXPIRED');
  assert.equal(result.retrySafe, false);
  assert.equal(result.receipt.receiptKind, 'blocked_action_receipt');
  assert.equal(result.receipt.decision, 'rejected');
});

test('an expired approval is refused even when it carries no expiresAt (legacy row)', () => {
  const handle = createMcpApprovalDecisionHandler({ failApprovalDecision: fail });
  // Written before this change: no context.expiresAt, old createdAt.
  const row = pendingRow({ createdMs: Date.now() - (DEFAULT_CASE_LIFETIME_MS + 1000) });
  assert.equal(row.context.expiresAt, undefined);
  const result = handle({}, { approvalId: 'a1', workspaceId: 'default', decision: 'approved' }, { approvalStore: storeWith(row) });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'APPROVAL_EXPIRED');
});

test('a fresh pending approval is not refused by the expiry check (the gate is not blanket-deny)', () => {
  const handle = createMcpApprovalDecisionHandler({ failApprovalDecision: fail });
  const row = pendingRow({ createdMs: Date.now() });
  const result = handle({}, { approvalId: 'a1', workspaceId: 'default', decision: 'approved' }, { approvalStore: storeWith(row) });
  // It proceeds past the expiry gate and fails later for a different reason
  // (the store cannot claim), which is the proof the gate let it through.
  assert.notEqual(result.error?.code, 'APPROVAL_EXPIRED');
});

test('the configured TTL is what the decision-time check enforces', () => {
  const handle = createMcpApprovalDecisionHandler({ failApprovalDecision: fail });
  // 90s old: inside the default 15-minute lifetime, outside a 60s TTL.
  const row = pendingRow({ createdMs: Date.now() - 90_000 });
  const runtime = { approvalStore: storeWith(row), readEnvironment: (key) => (key === MCP_APPROVAL_TTL_ENV ? '60000' : undefined) };
  const result = handle({}, { approvalId: 'a1', workspaceId: 'default', decision: 'approved' }, runtime);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'APPROVAL_EXPIRED');
});

test('rejecting an expired approval is still allowed (expiry blocks approval, not rejection)', () => {
  const handle = createMcpApprovalDecisionHandler({ failApprovalDecision: fail });
  const row = pendingRow({ createdMs: Date.now() - (DEFAULT_CASE_LIFETIME_MS + 1000) });
  const store = storeWith(row);
  store.rejectToolApproval = () => ({ rejected: true, approval: { ...row, status: 'rejected', decision: 'rejected' } });
  const result = handle({}, { approvalId: 'a1', workspaceId: 'default', decision: 'rejected' }, { approvalStore: store });
  assert.notEqual(result.error?.code, 'APPROVAL_EXPIRED');
});

// --- single-use idempotency: a decided approval is closed to replay --------

test('a second decision on an already-approved approval is idempotent, not a second execution', () => {
  const handle = createMcpApprovalDecisionHandler({ failApprovalDecision: fail });
  const approved = { ...pendingRow(), status: 'approved', decision: 'approved' };
  let claims = 0;
  const store = storeWith(approved);
  store.claimToolApproval = () => { claims += 1; return { claimed: true, approval: approved }; };

  const first = handle({}, { approvalId: 'a1', workspaceId: 'default', decision: 'approved' }, { approvalStore: store });
  const second = handle({}, { approvalId: 'a1', workspaceId: 'default', decision: 'approved' }, { approvalStore: store });

  assert.equal(first.data.idempotent, true);
  assert.equal(second.data.idempotent, true);
  assert.equal(second.data.executed, false, 'a replayed decision must not execute again');
  assert.equal(claims, 0, 'a final approval is never re-claimed for execution');
});

test('flipping a decided approval (replay with the opposite decision) fails closed', () => {
  const handle = createMcpApprovalDecisionHandler({ failApprovalDecision: fail });
  const rejected = { ...pendingRow(), status: 'rejected', decision: 'rejected' };
  const result = handle({}, { approvalId: 'a1', workspaceId: 'default', decision: 'approved' }, { approvalStore: storeWith(rejected) });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'APPROVAL_ALREADY_FINAL');
});

test('an approval already reserved for execution cannot be claimed a second time', () => {
  const handle = createMcpApprovalDecisionHandler({ failApprovalDecision: fail });
  const executing = { ...pendingRow(), status: 'executing', decision: 'approved' };
  const store = storeWith(executing);
  store.claimToolApproval = () => ({ claimed: false, approval: executing });
  const result = handle({}, { approvalId: 'a1', workspaceId: 'default', decision: 'approved' }, { approvalStore: store });
  assert.equal(result.ok, false, 'a reserved approval is not re-executable');
  assert.notEqual(result.error?.code, undefined);
});
