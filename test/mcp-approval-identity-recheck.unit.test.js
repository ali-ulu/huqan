'use strict';

// Unit coverage for the #3876 post-claim identity re-check and for
// evaluateMcpAgentIdentity's own guards. The end-to-end proof lives in
// test/mcp-approval-identity-revocation.test.js; this file drives the
// fallbacks a real store or ledger only reaches when it fails.

const assert = require('node:assert/strict');
const test = require('node:test');

const { executeApprovedLearn } = require('../lib/mcp-approval-learn-execution');
const { evaluateMcpAgentIdentity } = require('../lib/mcp-oversight-identity');

const fail = (code, message, meta = {}) => ({ ok: false, error: { code, message }, meta });

// An identity runtime evaluateMcpAgentIdentity refuses outright, so the
// re-check always blocks without a full authority fixture.
const UNUSABLE_IDENTITY_RUNTIME = { agentIdentityRuntime: [] };

function learnRow(overrides = {}) {
  return {
    id: 'a1',
    tool: 'huqan.learn',
    input: JSON.stringify({ text: 'bounded' }),
    status: 'pending',
    context: { workspaceId: 'w', args: { text: 'bounded' } },
    ...overrides,
  };
}

function claimingStore(overrides = {}) {
  const calls = { finalize: [], fail: [] };
  const store = {
    calls,
    claimToolApproval: () => ({ claimed: true, approval: { id: 'a1', status: 'executing' } }),
    finalizeToolApprovalWithReceipt: (id, options) => {
      calls.finalize.push(options);
      return { finalized: true, approval: { id, status: 'rejected', reason: options.reason } };
    },
    failToolApproval: (id, reason) => {
      calls.fail.push(reason);
      return { approval: { id, status: 'failed', reason } };
    },
    getToolApprovalById: (id) => ({ id, status: 'executing' }),
    ...overrides,
  };
  return store;
}

function run({ store, existing = learnRow(), oversightRuntime = { recordExecutionOutcome: () => ({ ok: false }) } }) {
  let executed = 0;
  const result = executeApprovedLearn({
    kernel: { graph: null, learn: () => { executed += 1; return { ok: true }; } },
    approvalStore: store,
    approvalId: 'a1',
    workspaceId: 'w',
    reason: 'mcp_approved',
    decision: 'approved',
    existing,
    storedArgs: { text: 'bounded' },
    oversightRequired: false,
    runtime: UNUSABLE_IDENTITY_RUNTIME,
    oversightCase: { input: { caseId: 'case-1' } },
    oversightRuntime,
    identityEvaluation: { enabled: true, ok: true },
    args: {},
    failApprovalDecision: fail,
  });
  return { result, executed };
}

test('the re-check blocks before the executor and closes the row rejected with a not-executed receipt', () => {
  const store = claimingStore();
  const { result, executed } = run({ store });

  assert.equal(executed, 0);
  assert.equal(result.error.code, 'IDENTITY_ENFORCEMENT_BLOCKED');
  assert.equal(result.meta.phase, 'pre_execution');
  assert.equal(result.meta.approval.status, 'rejected');
  assert.equal(result.meta.receipt.actionExecution, 'not_executed');
  assert.equal(result.meta.receipt.actor, 'mcp');
  assert.equal(result.meta.receipt.requestedVerdict, 'review');
  assert.equal(store.calls.finalize[0].reason, 'identity_blocked_before_execution:identity.evaluation_failed');
  assert.equal(result.meta.oversightOutcome, 'unrecorded');
});

test('the blocked receipt carries the row provenance actor and requested verdict', () => {
  const store = claimingStore();
  const existing = learnRow({ decision: 'block', context: { workspaceId: 'w', args: { text: 'bounded' }, provenance: { actor: 'agent:worker' } } });
  const { result } = run({ store, existing, oversightRuntime: { recordExecutionOutcome: () => ({ ok: true, execution: { outcome: 'not_attempted' } }) } });

  assert.equal(result.meta.receipt.actor, 'agent:worker');
  assert.equal(result.meta.receipt.requestedVerdict, 'block');
  assert.equal(result.meta.oversightOutcome, 'not_attempted');
});

test('a store that cannot finalize falls back to failed and returns no receipt', () => {
  const store = claimingStore({ finalizeToolApprovalWithReceipt: () => null });
  const { result, executed } = run({ store });

  assert.equal(executed, 0);
  assert.equal(result.meta.approval.status, 'failed');
  assert.equal(result.meta.receipt, undefined);
  assert.deepEqual(store.calls.fail, ['identity_blocked_before_execution:identity.evaluation_failed']);
});

test('a store that throws on every write still refuses and reads the row back', () => {
  const store = claimingStore({
    finalizeToolApprovalWithReceipt: () => { throw new Error('SQLITE_BUSY'); },
    failToolApproval: () => { throw new Error('SQLITE_BUSY'); },
  });
  const { result, executed } = run({
    store,
    oversightRuntime: { recordExecutionOutcome: () => { throw new Error('ledger down'); } },
  });

  assert.equal(executed, 0);
  assert.equal(result.error.code, 'IDENTITY_ENFORCEMENT_BLOCKED');
  assert.equal(result.meta.approval.status, 'executing');
  assert.equal(result.meta.oversightOutcome, 'unrecorded');
});

test('a failed store whose fallback returns nothing and whose read throws still refuses', () => {
  const store = claimingStore({
    finalizeToolApprovalWithReceipt: () => ({ finalized: false }),
    failToolApproval: () => null,
    getToolApprovalById: () => { throw new Error('SQLITE_BUSY'); },
  });
  const { result, executed } = run({ store });

  assert.equal(executed, 0);
  assert.equal(result.error.code, 'IDENTITY_ENFORCEMENT_BLOCKED');
  assert.equal(result.meta.approval, null);
});

test('the re-check is skipped when identity was never evaluated', () => {
  let executed = 0;
  const result = executeApprovedLearn({
    kernel: { graph: null, learn: () => { executed += 1; return { ok: false }; } },
    approvalStore: claimingStore(),
    approvalId: 'a1',
    workspaceId: 'w',
    reason: 'mcp_approved',
    decision: 'approved',
    existing: learnRow(),
    storedArgs: { text: 'bounded' },
    oversightRequired: false,
    runtime: UNUSABLE_IDENTITY_RUNTIME,
    oversightCase: { input: {} },
    oversightRuntime: null,
    identityEvaluation: { enabled: false, ok: true },
    args: {},
    failApprovalDecision: fail,
  });

  assert.equal(executed, 1);
  assert.equal(result.error.code, 'APPROVAL_EXECUTION_FAILED');
});

test('evaluateMcpAgentIdentity reports identity as not enforced only when no runtime is configured', () => {
  assert.deepEqual(evaluateMcpAgentIdentity({ runtime: {} }), { enabled: false, ok: true });
  assert.deepEqual(evaluateMcpAgentIdentity({ runtime: { agentIdentityRuntime: null } }), { enabled: false, ok: true });
  assert.deepEqual(evaluateMcpAgentIdentity(), { enabled: false, ok: true });
});

test('evaluateMcpAgentIdentity blocks a malformed runtime instead of passing it', () => {
  for (const agentIdentityRuntime of [[], 'runtime', { action: null }, { action: [] }]) {
    const result = evaluateMcpAgentIdentity({ runtime: { agentIdentityRuntime } });
    assert.equal(result.enabled, true);
    assert.equal(result.ok, false);
    assert.equal(result.result.reason, 'identity.evaluation_failed');
  }
});

test('evaluateMcpAgentIdentity blocks a receiver that does not match the requester or the workspace', () => {
  const agentIdentityRuntime = {
    action: { capability: 'learn' },
    receiver: { subject: 'receiver-a', kind: 'mcp-server', workspaceId: 'w' },
  };
  const subjectMismatch = evaluateMcpAgentIdentity({
    runtime: { agentIdentityRuntime },
    oversightInput: { requesterContext: { subject: 'someone-else' }, action: { workspaceId: 'w' } },
  });
  assert.equal(subjectMismatch.result.reason, 'identity.claim_binding_mismatch');

  const workspaceMismatch = evaluateMcpAgentIdentity({
    runtime: { agentIdentityRuntime },
    oversightInput: { requesterContext: {}, action: { workspaceId: 'other' } },
  });
  assert.equal(workspaceMismatch.result.reason, 'identity.workspace_mismatch');
});
