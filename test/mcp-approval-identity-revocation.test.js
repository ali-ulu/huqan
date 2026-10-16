'use strict';

// Scenario 01 (#3873): authorization withdrawn while an MCP action is pending.
// Each test proves an outcome by the approval row state and the executor
// count, not by the refusal code alone: a refusal that still ran the action
// would be a pass on the wrong evidence.

const assert = require('node:assert/strict');
const test = require('node:test');

const { callTool } = require('../mcpServer');
const {
  FIXTURE_NOW_MS,
  fixture,
  identityRecord,
  identityRuntime,
  queueParams,
  operatorParams,
  runtimeOptions,
} = require('./helpers/mcp-identity-approval-fixture');

function approve(f, approvalId, overrides = {}) {
  return callTool(f.kernel, operatorParams('huqan.approve', {
    approvalId,
    workspaceId: 'workspace-mcp',
    decision: 'approved',
  }), runtimeOptions(f, overrides));
}

function revokedRuntime(f, records) {
  return identityRuntime({ identities: records, clock: f.clock });
}

test('#3874: identity revoked while the approval is queued blocks the decision before claim and executor', async () => {
  const f = fixture();
  try {
    const queued = callTool(f.kernel, queueParams(), runtimeOptions(f));
    assert.equal(queued.approval.context.oversightRequired, true);
    assert.equal(f.store.getToolApprovalById(queued.approval.id).status, 'pending');

    // The authority snapshot refuses a record carrying revoked_at
    // (validateIdentityRecord), so a host revokes by publishing a snapshot
    // without it. The refusal reads identity.unknown: the revocation reason
    // does not survive into the evidence (recorded on #3874).
    assert.throws(() => revokedRuntime(f, [{
      ref: 'identity:mcp-001',
      record: identityRecord({ revoked_at: '2026-08-19T09:59:00.000Z', revocation_reason: 'operator_withdrew_authority' }),
    }]), /identity\.authority_invalid/);
    const revoked = revokedRuntime(f, [{
      ref: 'identity:other-001',
      record: identityRecord({ agent_id: 'agent-other-001' }),
    }]);
    const blocked = await approve(f, queued.approval.id, { agentIdentityRuntime: revoked });

    assert.equal(blocked.ok, false, JSON.stringify(blocked));
    assert.equal(blocked.error.code, 'IDENTITY_ENFORCEMENT_BLOCKED');
    assert.equal(blocked.meta.identity.reason, 'identity.unknown');
    assert.equal(blocked.meta.retrySafe, false);
    const row = f.store.getToolApprovalById(queued.approval.id);
    assert.equal(row.status, 'pending');
    assert.equal(row.context.receipt, undefined);
    assert.equal(f.executions, 0);
  } finally {
    f.cleanup();
  }
});

test('#3874: revoking only the parent of a delegated identity blocks the decision', async () => {
  const parent = identityRecord({
    agent_id: 'agent-root-001',
    display_name: 'Root Authority Agent',
    delegation_scope: ['learn'],
  });
  const child = identityRecord({
    parent_agent_id: 'agent-root-001',
    delegation_chain: ['agent-root-001', 'agent-mcp-001'],
  });
  const f = fixture({
    identities: [
      { ref: 'identity:root-001', record: parent },
      { ref: 'identity:mcp-001', record: child },
    ],
  });
  try {
    const queued = callTool(f.kernel, queueParams(), runtimeOptions(f));
    const revoked = revokedRuntime(f, [
      { ref: 'identity:mcp-001', record: child },
    ]);
    const blocked = await approve(f, queued.approval.id, { agentIdentityRuntime: revoked });

    assert.equal(blocked.ok, false, JSON.stringify(blocked));
    assert.equal(blocked.error.code, 'IDENTITY_ENFORCEMENT_BLOCKED');
    assert.equal(blocked.meta.identity.reason, 'delegation.chain_invalid');
    assert.equal(f.store.getToolApprovalById(queued.approval.id).status, 'pending');
    assert.equal(f.executions, 0);
  } finally {
    f.cleanup();
  }
});

test('#3875: an oversight row is not approvable without a configured identity runtime', async () => {
  const f = fixture();
  try {
    const queued = callTool(f.kernel, queueParams(), runtimeOptions(f, { agentIdentityRuntime: null }));
    assert.equal(queued.approval.context.oversightRequired, true);

    const blocked = await approve(f, queued.approval.id, { agentIdentityRuntime: null });

    assert.equal(blocked.ok, false, JSON.stringify(blocked));
    assert.equal(blocked.error.code, 'IDENTITY_RUNTIME_UNAVAILABLE');
    assert.match(blocked.error.message, /agentIdentityRuntime/);
    assert.equal(blocked.meta.retrySafe, false);
    assert.equal(f.store.getToolApprovalById(queued.approval.id).status, 'pending');
    assert.equal(f.executions, 0);
  } finally {
    f.cleanup();
  }
});

test('#3875: rejecting an oversight row still works without an identity runtime', async () => {
  const f = fixture();
  try {
    const queued = callTool(f.kernel, queueParams(), runtimeOptions(f, { agentIdentityRuntime: null }));
    const rejected = await callTool(f.kernel, operatorParams('huqan.approve', {
      approvalId: queued.approval.id,
      workspaceId: 'workspace-mcp',
      decision: 'rejected',
    }), runtimeOptions(f, { agentIdentityRuntime: null }));

    assert.equal(rejected.ok, true, JSON.stringify(rejected));
    assert.equal(f.store.getToolApprovalById(queued.approval.id).status, 'rejected');
    assert.equal(f.executions, 0);
  } finally {
    f.cleanup();
  }
});

test('#3876: identity that stops being valid after the decision check is caught after claim, before the executor', async () => {
  const expiresAt = new Date(FIXTURE_NOW_MS + 1000).toISOString();
  const f = fixture({
    identities: [{ ref: 'identity:mcp-001', record: identityRecord({ expires_at: expiresAt }) }],
    // Time passes while this call owns the row: the decision-time check saw a
    // valid identity, the pre-execution check must not.
    onClaim: (self) => self.advanceClock(5000),
  });
  try {
    const queued = callTool(f.kernel, queueParams(), runtimeOptions(f));
    const quorum = await approve(f, queued.approval.id);
    assert.equal(quorum.error.code, 'OVERSIGHT_QUORUM_PENDING');

    const blocked = await approve(f, queued.approval.id, {
      humanOversightApproverContext: { identityRef: 'human:operator-b', identityHash: 'hash-operator-b' },
    });

    assert.equal(blocked.ok, false, JSON.stringify(blocked));
    assert.equal(blocked.error.code, 'IDENTITY_ENFORCEMENT_BLOCKED');
    assert.equal(blocked.meta.phase, 'pre_execution');
    assert.equal(blocked.meta.identity.reason, 'identity.expired');
    assert.equal(blocked.meta.retrySafe, false);
    const row = f.store.getToolApprovalById(queued.approval.id);
    assert.equal(row.status, 'rejected');
    assert.equal(row.context.receipt.actionExecution, 'not_executed');
    assert.equal(blocked.meta.receipt.receiptId, row.context.receipt.receiptId);
    // The oversight ledger answers its recorded approval with an outcome.
    // A case starts at executionOutcome 'not_attempted', so the field proves
    // nothing; replaying the same outcome only reports `replayed` when the
    // ledger already holds it.
    assert.equal(blocked.meta.oversightOutcome, 'not_attempted');
    const replay = f.oversight.recordExecutionOutcome({
      caseId: queued.approval.oversight.caseId,
      outcome: 'not_attempted',
      reason: 'identity_blocked_before_execution:identity.expired',
    });
    assert.equal(replay.ok, true, JSON.stringify(replay));
    assert.equal(replay.replayed, true);
    assert.match(row.reason, /^identity_blocked_before_execution:identity\.expired$/);
    assert.equal(f.executions, 0);
  } finally {
    f.cleanup();
  }
});

test('#3876: a pre-execution identity block that cannot close the row as rejected leaves it failed, never executed', async () => {
  const expiresAt = new Date(FIXTURE_NOW_MS + 1000).toISOString();
  const f = fixture({
    identities: [{ ref: 'identity:mcp-001', record: identityRecord({ expires_at: expiresAt }) }],
    onClaim: (self) => self.advanceClock(5000),
  });
  f.store.finalizeToolApprovalWithReceipt = () => ({ finalized: false, approval: null });
  try {
    const queued = callTool(f.kernel, queueParams(), runtimeOptions(f));
    await approve(f, queued.approval.id);
    const blocked = await approve(f, queued.approval.id, {
      humanOversightApproverContext: { identityRef: 'human:operator-b', identityHash: 'hash-operator-b' },
    });

    assert.equal(blocked.error.code, 'IDENTITY_ENFORCEMENT_BLOCKED');
    assert.equal(blocked.meta.phase, 'pre_execution');
    const row = f.store.getToolApprovalById(queued.approval.id);
    assert.equal(row.status, 'failed');
    assert.equal(row.reason, 'identity_blocked_before_execution:identity.expired');
    assert.equal(blocked.meta.approval.status, 'failed');
    assert.equal(blocked.meta.receipt, undefined);
    assert.equal(f.executions, 0);
  } finally {
    f.cleanup();
  }
});

test('#3876: a store that throws while closing the blocked row still leaves it failed, never executing', async () => {
  const expiresAt = new Date(FIXTURE_NOW_MS + 1000).toISOString();
  const f = fixture({
    identities: [{ ref: 'identity:mcp-001', record: identityRecord({ expires_at: expiresAt }) }],
    onClaim: (self) => self.advanceClock(5000),
  });
  f.store.finalizeToolApprovalWithReceipt = () => { throw Object.assign(new Error('SQLITE_BUSY'), { code: 'SQLITE_BUSY' }); };
  try {
    const queued = callTool(f.kernel, queueParams(), runtimeOptions(f));
    await approve(f, queued.approval.id);
    const blocked = await approve(f, queued.approval.id, {
      humanOversightApproverContext: { identityRef: 'human:operator-b', identityHash: 'hash-operator-b' },
    });

    assert.equal(blocked.error.code, 'IDENTITY_ENFORCEMENT_BLOCKED');
    assert.equal(blocked.meta.receipt, undefined);
    assert.equal(f.store.getToolApprovalById(queued.approval.id).status, 'failed');
    assert.equal(f.executions, 0);
  } finally {
    f.cleanup();
  }
});
