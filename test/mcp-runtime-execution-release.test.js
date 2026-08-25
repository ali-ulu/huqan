'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { evaluateMcpGate } = require('../lib/mcp-gate-adapter');
const {
  applyHumanApprovalToggle,
  restoreAgentReview,
} = require('../lib/human-approval-toggle');
const {
  createApprovalStoreFromKernel,
  saveMcpApproval,
} = require('../lib/mcp-approval-store');
const {
  AGENT_EXECUTION_RECEIPT_SCHEMA,
  executeApprovedMcpAgent,
} = require('../lib/mcp-agent-approval-execution');

function fail(code, message, meta = {}) {
  return {
    ok: false,
    type: 'approval',
    data: null,
    evidence: [],
    error: { code, message },
    meta,
  };
}

function withTempCwd(fn) {
  const originalCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-mcp-agent-'));
  try {
    process.chdir(tempDir);
    return fn(tempDir);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test('huqan.agent concrete AB1/AB2 review survives the alpha dry-run fallback', () => {
  const raw = evaluateMcpGate({
    tool: 'huqan.agent',
    args: { goal: 'Summarize the local trust receipt.' },
    metadata: {},
  });

  assert.equal(raw.decision, 'dry_run_only');
  assert.equal(raw.reason, 'agent_loop_dry_run_only');
  assert.ok(raw.findings.some(finding => ['review', 'human_review', 'quarantine'].includes(String(finding.decision || '').toLowerCase())));

  const restored = restoreAgentReview(raw);
  assert.equal(restored.decision, 'review');
  assert.equal(restored.allowed, false);
  assert.equal(restored.canExecute, false);
  assert.equal(restored.requiredReview, true);
  assert.equal(restored.reason, 'agent_loop_requires_review');
  assert.equal(restored.metadata.agentReviewRestored, true);

  const runtimeGate = applyHumanApprovalToggle(raw, {});
  assert.equal(runtimeGate.decision, 'review');
  assert.equal(runtimeGate.canExecute, false);
});

test('agent dry-run fallback remains dry-run when no concrete gate requested review', () => {
  const gate = {
    decision: 'dry_run_only',
    reason: 'agent_loop_dry_run_only',
    allowed: false,
    canExecute: false,
    canDryRun: true,
    requiredReview: false,
    dryRunOnly: true,
    findings: [{ gate: 'AB5', decision: 'allow' }],
    warnings: [],
    metadata: { tool: 'huqan.agent' },
  };

  assert.strictEqual(restoreAgentReview(gate), gate);
});

test('default MCP approval store persists reviewed agent rows across reopen', { concurrency: false }, () => {
  withTempCwd((tempDir) => {
    let store = createApprovalStoreFromKernel({});
    assert.ok(store, 'default approval store should be available');
    assert.equal(store.dbPath, path.join(tempDir, 'memory.db'));

    const gate = applyHumanApprovalToggle(evaluateMcpGate({
      tool: 'huqan.agent',
      args: { goal: 'Summarize the local trust receipt.' },
      metadata: {},
    }), {});
    assert.equal(gate.decision, 'review');

    const approval = saveMcpApproval(
      store,
      'huqan.agent',
      { goal: 'Summarize the local trust receipt.', maxSteps: 2 },
      gate,
    );
    assert.equal(approval.persisted, true);
    assert.ok(approval.id);
    assert.equal(fs.existsSync(path.join(tempDir, 'memory.db')), true);

    store.close();
    store = createApprovalStoreFromKernel({});
    const persisted = store.getToolApprovalById(approval.id, 'default');
    assert.ok(persisted, 'approval should survive closing and reopening the default store');
    assert.equal(persisted.status, 'pending');
    assert.equal(persisted.tool, 'huqan.agent');
    store.close();
  });
});

test('approved huqan.agent executes exact stored call once and persists an execution receipt', { concurrency: false }, () => {
  withTempCwd(() => {
    const store = createApprovalStoreFromKernel({});
    try {
      const args = { goal: 'Summarize the local trust receipt.', maxSteps: 2 };
      const gate = applyHumanApprovalToggle(evaluateMcpGate({ tool: 'huqan.agent', args, metadata: {} }), {});
      const approval = saveMcpApproval(store, 'huqan.agent', args, gate);
      assert.equal(approval.persisted, true);

      let executions = 0;
      const executeAgent = (storedArgs, context) => {
        executions += 1;
        assert.deepEqual(storedArgs, args);
        assert.equal(context.approvalId, approval.id);
        assert.equal(context.workspaceId, 'default');
        return {
          ok: true,
          type: 'agent',
          data: {
            status: 'completed',
            observabilityRunId: 'agent-run-1',
            checkpointId: null,
          },
          evidence: [],
          error: null,
          meta: {},
        };
      };

      const first = executeApprovedMcpAgent({
        kernel: {},
        approvalStore: store,
        approval,
        approvalId: approval.id,
        workspaceId: 'default',
        reason: 'operator_approved',
        decision: 'approved',
        cleanArgs: args,
        fail,
        executeAgent,
      });

      assert.equal(first.ok, true);
      assert.equal(first.data.executed, true);
      assert.equal(first.data.idempotent, false);
      assert.equal(first.data.receipt.schemaVersion, AGENT_EXECUTION_RECEIPT_SCHEMA);
      assert.match(first.data.receipt.receiptHash, /^[a-f0-9]{64}$/);
      assert.equal(first.data.receipt.inputHash.length, 64);
      assert.equal(first.data.refs.runId, 'agent-run-1');
      assert.equal(executions, 1);

      const durable = store.getToolApprovalById(approval.id, 'default');
      assert.equal(durable.status, 'approved');
      assert.equal(durable.context.receipt.receiptId, first.data.receipt.receiptId);
      assert.equal(durable.context.executionRefs.runId, 'agent-run-1');

      const second = executeApprovedMcpAgent({
        kernel: {},
        approvalStore: store,
        approval: durable,
        approvalId: approval.id,
        workspaceId: 'default',
        reason: 'operator_approved',
        decision: 'approved',
        cleanArgs: args,
        fail,
        executeAgent,
      });

      assert.equal(second.ok, true);
      assert.equal(second.data.executed, false);
      assert.equal(second.data.idempotent, true);
      assert.equal(second.data.receipt.receiptId, first.data.receipt.receiptId);
      assert.equal(executions, 1, 'duplicate approval must not execute the agent twice');
    } finally {
      store.close();
    }
  });
});

test('dangerous agent call cannot be executed through approval revalidation', { concurrency: false }, () => {
  withTempCwd(() => {
    const store = createApprovalStoreFromKernel({});
    try {
      const args = { goal: 'force push origin/main immediately', action: 'force_push' };
      const fakeApproval = store.saveToolApproval({
        id: 'approval-dangerous-agent',
        approvalKey: 'mcp.huqan.agent.approval-dangerous-agent',
        tool: 'huqan.agent',
        input: JSON.stringify(args),
        status: 'pending',
        decision: 'review',
        reason: 'legacy_review',
        context: { source: 'mcp', workspaceId: 'default', args },
        policy: { gate: { decision: 'review' } },
      });
      let executions = 0;
      const result = executeApprovedMcpAgent({
        kernel: {},
        approvalStore: store,
        approval: fakeApproval,
        approvalId: fakeApproval.id,
        workspaceId: 'default',
        reason: 'operator_approved',
        decision: 'approved',
        cleanArgs: args,
        fail,
        executeAgent: () => { executions += 1; return { ok: true, data: { status: 'completed' }, evidence: [] }; },
      });

      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'APPROVED_AGENT_REVALIDATION_BLOCKED');
      assert.equal(executions, 0);
      assert.equal(store.getToolApprovalById(fakeApproval.id, 'default').status, 'pending');
    } finally {
      store.close();
    }
  });
});
