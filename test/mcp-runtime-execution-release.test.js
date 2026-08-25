'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { evaluateMcpGate } = require('../lib/mcp-gate-adapter');
const {
  applyHumanApprovalToggle,
  releaseCleanAgentLoop,
} = require('../lib/human-approval-toggle');
const {
  createApprovalStoreFromKernel,
  saveMcpApproval,
} = require('../lib/mcp-approval-store');

test('clean huqan.agent call is released to the guarded runtime', () => {
  const gated = evaluateMcpGate({
    tool: 'huqan.agent',
    args: { goal: 'Summarize the local trust receipt.' },
    metadata: {},
  });

  assert.equal(gated.decision, 'dry_run_only');
  assert.equal(gated.reason, 'agent_loop_dry_run_only');

  const released = applyHumanApprovalToggle(gated, {});
  assert.equal(released.decision, 'allow');
  assert.equal(released.allowed, true);
  assert.equal(released.canExecute, true);
  assert.equal(released.canDryRun, false);
  assert.equal(released.reason, 'agent_loop_gates_passed');
  assert.equal(released.metadata.agentExecutionReleased, true);
  assert.equal(released.metadata.originalDecision, 'dry_run_only');
  assert.ok(released.findings.some(finding => finding.gate === 'AB5'));
  assert.ok(released.findings.some(finding => finding.gate === 'AB8'));
});

test('agent fallback is not released when a concrete gate requested review', () => {
  const gated = {
    decision: 'dry_run_only',
    reason: 'agent_loop_dry_run_only',
    allowed: false,
    canExecute: false,
    canDryRun: true,
    requiredReview: false,
    dryRunOnly: true,
    findings: [{ gate: 'AB8', decision: 'review' }],
    warnings: [],
    metadata: { tool: 'huqan.agent' },
  };

  assert.strictEqual(releaseCleanAgentLoop(gated), gated);
});

test('agent fallback is not released when AB9 found sensitive egress', () => {
  const gated = {
    decision: 'dry_run_only',
    reason: 'agent_loop_dry_run_only',
    allowed: false,
    canExecute: false,
    canDryRun: true,
    requiredReview: false,
    dryRunOnly: true,
    findings: [{ gate: 'AB9', piiDetected: true, secretDetected: false }],
    warnings: [],
    metadata: { tool: 'huqan.agent' },
  };

  assert.strictEqual(releaseCleanAgentLoop(gated), gated);
});

test('default MCP approval store persists review rows across reopen', { concurrency: false }, () => {
  const originalCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-mcp-approval-'));
  let store;
  let reopened;

  try {
    process.chdir(tempDir);
    store = createApprovalStoreFromKernel({});
    assert.ok(store, 'default approval store should be available');
    assert.equal(store.dbPath, path.join(tempDir, 'memory.db'));

    const approval = saveMcpApproval(
      store,
      'huqan.learn',
      { text: 'durable review candidate', workspaceId: 'default' },
      {
        decision: 'review',
        allowed: false,
        canExecute: false,
        canDryRun: true,
        requiredReview: true,
        reason: 'mutating_requires_review',
        metadata: { workspaceId: 'default' },
      },
    );

    assert.equal(approval.persisted, true);
    assert.ok(approval.id);
    assert.equal(fs.existsSync(path.join(tempDir, 'memory.db')), true);

    store.close();
    store = null;

    reopened = createApprovalStoreFromKernel({});
    const persisted = reopened.getToolApprovalById(approval.id, 'default');
    assert.ok(persisted, 'approval should survive closing and reopening the default store');
    assert.equal(persisted.status, 'pending');
    assert.equal(persisted.tool, 'huqan.learn');
  } finally {
    try { reopened?.close?.(); } catch (_) {}
    try { store?.close?.(); } catch (_) {}
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
