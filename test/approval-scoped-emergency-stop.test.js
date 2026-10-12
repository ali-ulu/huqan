'use strict';

// #3878: cancelling one approved execution while it runs. The stop is the
// existing emergency-stop ledger, read at every step boundary; an agent-scope
// stop on `approval:<approvalId>` reaches that execution and no other. Proof
// is the executor call count and the step list, not the refusal code alone.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KernelV2 = require('../kernel.v2');
const HuqanStorage = require('../storage');
const { createAgent } = require('../agentRuntime');
const { createEmergencyStop, approvalStopAgentId } = require('../lib/emergency-stop');
const { executeAgentStep } = require('../lib/agent-step-executor');
const { evaluateMcpGate } = require('../lib/mcp-gate-adapter');
const { applyHumanApprovalToggle } = require('../lib/human-approval-toggle');
const { createApprovalStoreFromKernel, saveMcpApproval } = require('../lib/mcp-approval-store');
const { executeApprovedMcpAgent } = require('../lib/mcp-agent-approval-execution');
const { createMcpApprovalDecisionHandler } = require('../lib/mcp-approval-decision-handler');

const fail = (code, message, meta = {}) => ({ ok: false, type: 'approval', data: null, evidence: [], error: { code, message }, meta });
const GOAL = 'ask three questions about cats then summarize';

function ledgerIn(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-approval-stop-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return createEmergencyStop({ directory });
}

function stepThrough(ledger, opts) {
  return executeAgentStep({
    step: { id: 's1', action: 'ask', tool: 'ask', input: 'x' },
    state: { workspaceId: 'w', agentId: 'agent-v3' },
    opts: { emergencyStop: ledger, ...opts },
    runtime: { kernel: {}, allowedTools: new Set(['ask']), emit() { throw new Error('passed_stop_check'); } },
  });
}

test('an approval-scoped stop blocks the next step of that approval only', (t) => {
  const ledger = ledgerIn(t);
  ledger.stop({ scope: 'agent', workspaceId: 'w', agentId: approvalStopAgentId('a1'), reason: 'operator_cancelled', actor: 'operator:test' });

  const report = stepThrough(ledger, { approvalId: 'a1' });
  assert.equal(report.status, 'blocked');
  assert.equal(report.result.error.code, 'AGENT_EMERGENCY_STOPPED');
  assert.equal(report.result.meta.emergencyStop.approvalId, 'a1');
  assert.equal(report.result.meta.emergencyStop.target, approvalStopAgentId('a1'));

  assert.throws(() => stepThrough(ledger, { approvalId: 'a2' }), /passed_stop_check/);
  assert.throws(() => stepThrough(ledger, {}), /passed_stop_check/);
});

test('a stop on the run agent records that agent as the target', (t) => {
  const ledger = ledgerIn(t);
  ledger.stop({ scope: 'agent', workspaceId: 'w', agentId: 'agent-v3', reason: 'operator_stopped_agent', actor: 'operator:test' });

  const report = stepThrough(ledger, { approvalId: 'a1' });
  assert.equal(report.result.meta.emergencyStop.scope, 'agent');
  assert.equal(report.result.meta.emergencyStop.target, 'agent-v3');
  assert.equal(report.result.meta.emergencyStop.approvalId, undefined);
});

test('a workspace stop records its scope and no agent target', (t) => {
  const ledger = ledgerIn(t);
  ledger.stop({ scope: 'workspace', workspaceId: 'w', reason: 'operator_stopped_workspace', actor: 'operator:test' });

  const report = stepThrough(ledger, { approvalId: 'a1' });
  assert.equal(report.result.meta.emergencyStop.scope, 'workspace');
  assert.equal(report.result.meta.emergencyStop.target, null);
});

test('approvalStopAgentId names the stop target an operator passes to huqan.emergency_stop', () => {
  assert.equal(approvalStopAgentId('apr_123'), 'approval:apr_123');
  assert.throws(() => approvalStopAgentId(''), /approval id/);
});

function withIsolatedRuntime(fn) {
  const originalCwd = process.cwd();
  const saved = { stop: process.env.HUQAN_EMERGENCY_STOP_DIR, state: process.env.HUQAN_STATE_ROOT };
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-approval-cancel-')));
  process.env.HUQAN_EMERGENCY_STOP_DIR = path.join(dir, 'stops');
  process.env.HUQAN_STATE_ROOT = path.join(dir, 'state');
  process.chdir(dir);
  const restore = () => {
    process.chdir(originalCwd);
    for (const [key, value] of [['HUQAN_EMERGENCY_STOP_DIR', saved.stop], ['HUQAN_STATE_ROOT', saved.state]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return Promise.resolve().then(() => fn(dir)).finally(restore);
}

/**
 * @param {object} options
 * @param {'before'|'during'|null} options.stopWhen when the operator stops
 * @param {Function} [options.stopApprovalOf] which approval the stop names
 * @param {boolean} [options.multiStep] run a real multi-step AgentV3 instead
 *   of the default approved-agent path (which plans a single dream step)
 */
function approvedAgentFixture(dir, { stopWhen = null, stopApprovalOf = (approval) => approval.id, multiStep = false } = {}) {
  const store = createApprovalStoreFromKernel({});
  const args = { goal: GOAL, maxSteps: 4 };
  const gate = applyHumanApprovalToggle(evaluateMcpGate({ tool: 'huqan.agent', args, metadata: {} }), {});
  const approval = saveMcpApproval(store, 'huqan.agent', args, gate);
  const kernel = new KernelV2({ noLoad: true, useSQLite: false, loadPlugins: false, memoryPath: path.join(dir, 'graph.json') });
  const ledger = createEmergencyStop({ directory: process.env.HUQAN_EMERGENCY_STOP_DIR });
  const stop = () => ledger.stop({ scope: 'agent', workspaceId: 'default', agentId: approvalStopAgentId(stopApprovalOf(approval)), reason: 'operator_cancelled', actor: 'operator:test' });
  let asks = 0;
  kernel.ask = () => {
    asks += 1;
    if (asks === 1 && stopWhen === 'during') stop();
    return { ok: true, type: 'ask', data: { summary: `answer ${asks}` }, evidence: [] };
  };
  let agentStorage = null;
  const executeAgent = multiStep
    ? (cleanArgs, context) => {
      agentStorage = new HuqanStorage({ dbPath: path.join(dir, 'agent.db') });
      const agent = createAgent({ kernel, storage: agentStorage, maxSteps: 4, timeBudgetMs: 5000, dreamExperimentLoop: false, experienceJournal: null });
      return agent.run(cleanArgs.goal, { maxSteps: 4, workspaceId: context.workspaceId, approvalId: context.approvalId });
    }
    : null;
  const run = () => {
    if (stopWhen === 'before') stop();
    return executeApprovedMcpAgent({
      kernel, approvalStore: store, approval, approvalId: approval.id, workspaceId: 'default',
      reason: 'operator_approved', decision: 'approved', cleanArgs: args, fail,
      ...(executeAgent ? { executeAgent } : {}),
    });
  };
  return {
    store,
    approval,
    run,
    get asks() { return asks; },
    close() { agentStorage?.close(); store.close(); },
  };
}

test('stopping one approved execution mid-run ends it cancelled with an honest receipt', { concurrency: false }, () => withIsolatedRuntime(async (dir) => {
  const f = approvedAgentFixture(dir, { stopWhen: 'during', multiStep: true });
  try {
    const result = await f.run();

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.cancelled, true);
    assert.equal(f.asks, 1, 'no step after the stop may reach the kernel');
    const row = f.store.getToolApprovalById(f.approval.id, 'default');
    assert.equal(row.status, 'cancelled');
    const receipt = row.context.receipt;
    assert.equal(receipt.outcome, 'cancelled');
    assert.deepEqual(receipt.cancellation.completedSteps, ['context']);
    assert.equal(receipt.cancellation.stoppedBeforeStep, 'verify');
    assert.equal(receipt.cancellation.stopScope, 'agent');
    assert.equal(receipt.cancellation.stopTarget, approvalStopAgentId(f.approval.id));
    assert.equal(receipt.cancellation.sideEffectsRolledBack, false);
    assert.equal(result.data.receipt.receiptHash, receipt.receiptHash);
  } finally {
    f.close();
  }
}));

test('the default approved-agent path carries the approval id: a stop placed first runs no step', { concurrency: false }, () => withIsolatedRuntime(async (dir) => {
  const f = approvedAgentFixture(dir, { stopWhen: 'before' });
  try {
    const result = await f.run();

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.cancelled, true);
    const receipt = f.store.getToolApprovalById(f.approval.id, 'default').context.receipt;
    assert.deepEqual(receipt.cancellation.completedSteps, []);
    assert.ok(receipt.cancellation.stoppedBeforeStep);
    assert.equal(receipt.cancellation.stopTarget, approvalStopAgentId(f.approval.id));
  } finally {
    f.close();
  }
}));

test('a stop on another approval leaves this execution running to completion', { concurrency: false }, () => withIsolatedRuntime(async (dir) => {
  const f = approvedAgentFixture(dir, { stopWhen: 'during', stopApprovalOf: () => 'some-other-approval', multiStep: true });
  try {
    const result = await f.run();

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.cancelled, undefined);
    const row = f.store.getToolApprovalById(f.approval.id, 'default');
    assert.equal(row.status, 'approved');
    assert.equal(row.context.receipt.cancellation, undefined);
    assert.ok(f.asks >= 1);
    assert.notEqual(result.data.result.data.terminationReason, 'emergency_stop');
  } finally {
    f.close();
  }
}));

test('a cancelled approval is final: approving it again is refused', { concurrency: false }, () => withIsolatedRuntime(async (dir) => {
  const f = approvedAgentFixture(dir, { stopWhen: 'during', multiStep: true });
  try {
    await f.run();
    const decide = createMcpApprovalDecisionHandler({ failApprovalDecision: fail });
    const again = await decide({}, { approvalId: f.approval.id, workspaceId: 'default', decision: 'approved' }, { approvalStore: f.store });

    assert.equal(again.error.code, 'APPROVAL_ALREADY_FINAL');
    assert.equal(f.asks, 1);
  } finally {
    f.close();
  }
}));

test('the cancellation record names a workspace-wide stop without inventing an approval target', () => {
  const { buildAgentExecutionEvidence } = require('../lib/mcp-agent-approval-execution');
  const workspaceStop = buildAgentExecutionEvidence({
    approvalId: 'a1',
    workspaceId: 'w',
    args: { goal: GOAL },
    result: {
      ok: false,
      data: {
        status: 'blocked',
        terminationReason: 'emergency_stop',
        steps: [
          { id: 'context', status: 'done', result: { ok: true } },
          { id: 'verify', status: 'blocked', result: { ok: false, error: { code: 'AGENT_EMERGENCY_STOPPED' }, meta: { emergencyStop: { scope: 'workspace', target: null } } } },
        ],
      },
    },
  });
  assert.equal(workspaceStop.cancelled, true);
  assert.equal(workspaceStop.receipt.cancellation.stopScope, 'workspace');
  assert.equal(workspaceStop.receipt.cancellation.stopTarget, null);

  const agentStop = buildAgentExecutionEvidence({
    approvalId: 'a1',
    workspaceId: 'w',
    args: { goal: GOAL },
    result: { ok: false, data: { terminationReason: 'emergency_stop', steps: [
      { id: 'verify', status: 'blocked', result: { ok: false, error: { code: 'AGENT_EMERGENCY_STOPPED' }, meta: { emergencyStop: { scope: 'agent', target: 'agent-v3' } } } },
    ] } },
  });
  assert.equal(agentStop.receipt.cancellation.stopScope, 'agent');
  assert.equal(agentStop.receipt.cancellation.stopTarget, 'agent-v3');

  const noSteps = buildAgentExecutionEvidence({
    approvalId: 'a1',
    workspaceId: 'w',
    args: { goal: GOAL },
    result: { ok: false, data: { status: 'blocked', terminationReason: 'emergency_stop' } },
  });
  assert.deepEqual(noSteps.receipt.cancellation, {
    completedSteps: [], stoppedBeforeStep: null, stopScope: null, stopTarget: null, sideEffectsRolledBack: false,
  });

  const completed = buildAgentExecutionEvidence({ approvalId: 'a1', workspaceId: 'w', args: {}, result: { ok: true, data: { status: 'completed' } } });
  assert.equal(completed.cancelled, false);
  assert.equal(completed.receipt.outcome, 'completed');
  assert.equal(Object.hasOwn(completed.receipt, 'cancellation'), false);
});

test('a repair whose approval was cancelled is dropped on resume, not left waiting', () => {
  const { resolvePendingRepair, REPAIR_TOOL } = require('../lib/experience/run-repair');
  const failed = { id: 'ask-1', status: 'error', result: { ok: false } };
  const state = {
    workspaceId: 'w',
    steps: [],
    failedAttempts: [failed],
    pendingRepair: { approvalId: 'r1', repairStepId: 'ask-1-repair', stepId: 'ask-1' },
  };
  const queued = [{ id: 'ask-1-repair' }, { id: 'next' }];
  const agent = {
    storage: {
      getToolApprovalById: () => ({ id: 'r1', tool: REPAIR_TOOL, status: 'cancelled', context: { repair: { repairStepId: 'ask-1-repair' } } }),
    },
  };

  const decision = resolvePendingRepair({ agent, state, queued, opts: { repairApprovalId: 'r1' } });

  assert.equal(decision.action, 'drop');
  assert.deepEqual(queued.map((step) => step.id), ['next']);
  assert.equal(state.pendingRepair, undefined);
  assert.deepEqual(state.steps, [failed]);
});

test('an approved repair run carries its approval id, so an approval-scoped stop reaches it', async () => {
  const { executeApprovedRepair } = require('../lib/mcp-agent-repair-execution');
  let runOptions = null;
  const approval = {
    id: 'r1',
    tool: 'huqan.agent_repair',
    status: 'pending',
    context: { args: { goal: GOAL, workspaceId: 'w', checkpointId: 'cp-1', resumeToken: 'tok' } },
  };
  const store = {
    claimToolApproval: () => ({ claimed: true, approval: { ...approval, status: 'executing' } }),
    finalizeToolApprovalWithReceipt: (id, options) => ({ finalized: true, approval: { ...approval, status: options.decision, context: { receipt: options.receipt } } }),
    failToolApproval: () => null,
    getToolApprovalById: () => approval,
  };
  await executeApprovedRepair({
    kernel: {}, approvalStore: store, approval, approvalId: 'r1', workspaceId: 'w', reason: 'operator_approved',
    decision: 'approved', fail, tool: 'huqan.agent_repair',
    createRepairAgent: () => ({ run: (goal, options) => { runOptions = options; return { ok: true, data: { status: 'completed' } }; } }),
  });

  assert.equal(runOptions.approvalId, 'r1');
  assert.equal(runOptions.repairApprovalId, 'r1');
});

test('re-executing a cancelled approval says it was cancelled instead of reporting a claim conflict', () => {
  const cancelled = { id: 'a1', tool: 'huqan.agent', status: 'cancelled', context: { receipt: { receiptId: 'r-1', outcome: 'cancelled' } } };
  const result = executeApprovedMcpAgent({
    kernel: {},
    approvalStore: {
      claimToolApproval: () => ({ claimed: false, approval: cancelled }),
      getToolApprovalById: () => cancelled,
    },
    approval: cancelled, approvalId: 'a1', workspaceId: 'default', reason: 'operator_approved', decision: 'approved',
    cleanArgs: { goal: GOAL }, fail,
    executeAgent: () => { throw new Error('a cancelled approval must not run again'); },
  });

  assert.equal(result.error.code, 'APPROVAL_ALREADY_CANCELLED');
  assert.equal(result.meta.receipt.receiptId, 'r-1');
  assert.equal(result.meta.retrySafe, false);
});
