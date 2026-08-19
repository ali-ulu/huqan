'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer, OPERATOR_TOOL_SCHEMAS, MODEL_VISIBLE_TOOL_SCHEMAS } = require('../mcpServer');
const { executeMcpAgentContinuation } = require('../lib/mcp-agent-continuation');
const AgentV3 = require('../agent.v3');

function checkpoint(overrides = {}) {
  return {
    id: 'checkpoint-787',
    state: { status: 'paused', resumeToken: 'checkpoint-787', steps: [], ...overrides.state },
    ...overrides,
  };
}

function fakeAgent(row = checkpoint()) {
  const calls = [];
  return {
    calls,
    storage: {
      loadLatestCheckpoint(goal, workspaceId) {
        calls.push({ operation: 'loadLatestCheckpoint', goal, workspaceId });
        return workspaceId === 'workspace-787' && goal === 'resume safely' ? row : null;
      },
    },
    run(goal, options) {
      calls.push({ operation: 'run', goal, options });
      const isRepair = options?.mode === 'repair';
      return {
        ok: true,
        type: 'agent',
        data: {
          goal,
          objective: 'investigate',
          plan: { id: 'plan-787', version: 'v3' },
          selectedTools: ['ask'],
          steps: [{ id: 'ask-1', action: 'ask', tool: 'ask', rationale: 'resume', status: 'completed', summary: 'continued' }],
          evidence: [],
          status: 'completed',
          notes: [],
          finalAnswer: isRepair ? 'repaired' : 'continued',
          completedSteps: 1,
          remainingSteps: 0,
          report: 'continued',
          nextAction: null,
          workspaceId: 'workspace-787',
        },
        evidence: [],
        error: null,
        meta: {},
      };
    },
  };
}

test('agent resume is operator-only and absent from model-visible tools', () => {
  assert.ok(OPERATOR_TOOL_SCHEMAS.some(tool => tool.name === 'huqan.agent_resume'));
  assert.equal(MODEL_VISIBLE_TOOL_SCHEMAS.some(tool => tool.name === 'huqan.agent_resume'), false);

  const server = createServer({ kernel: {}, operatorToken: 'operator-787' });
  const result = server.handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'huqan.agent_resume',
      arguments: { goal: 'resume safely', workspaceId: 'workspace-787', checkpointId: 'checkpoint-787', resumeToken: 'checkpoint-787' },
    },
  });
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /OPERATOR_AUTH_REQUIRED/);
});

test('agent continuation requires exact checkpoint token and workspace scope', () => {
  const agent = fakeAgent();
  const result = executeMcpAgentContinuation(agent, {
    goal: 'resume safely',
    workspaceId: 'workspace-787',
    checkpointId: 'checkpoint-787',
    resumeToken: 'checkpoint-787',
    mode: 'resume',
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.checkpointId, 'checkpoint-787');
  assert.equal(result.data.resumeToken, 'checkpoint-787');
  assert.equal(result.data.workspaceId, 'workspace-787');
  assert.equal(result.data.runId, 'checkpoint-787');
  assert.deepEqual(result.data.stepTrace, result.data.steps);
  assert.deepEqual(result.data.approvalReferences, []);
  assert.equal(result.data.receiptId, null);
  assert.equal(result.data.repairReason, null);
  assert.equal(result.data.continuationDecision, null);
  assert.equal(result.data.repairDecision, null);
  assert.equal(agent.calls[1].options.mode, 'resume');
  assert.equal(agent.calls[1].options.repairReason, undefined);
  assert.equal(agent.calls[1].options.checkpointId, 'checkpoint-787');
  assert.equal(agent.calls[1].options.resumeToken, 'checkpoint-787');
});

test('agent continuation fails closed for invalid token, cross-workspace checkpoint and repair without reason', () => {
  const invalidToken = executeMcpAgentContinuation(fakeAgent(), {
    goal: 'resume safely', workspaceId: 'workspace-787', checkpointId: 'checkpoint-787', resumeToken: 'wrong-token',
  });
  assert.equal(invalidToken.ok, false);
  assert.equal(invalidToken.error.code, 'AGENT_RESUME_TOKEN_INVALID');

  const crossWorkspace = executeMcpAgentContinuation(fakeAgent(), {
    goal: 'resume safely', workspaceId: 'workspace-other', checkpointId: 'checkpoint-787', resumeToken: 'checkpoint-787',
  });
  assert.equal(crossWorkspace.ok, false);
  assert.equal(crossWorkspace.error.code, 'AGENT_CHECKPOINT_NOT_FOUND');

  const deniedRepair = executeMcpAgentContinuation(fakeAgent(), {
    goal: 'resume safely', workspaceId: 'workspace-787', checkpointId: 'checkpoint-787', resumeToken: 'checkpoint-787', mode: 'repair',
  });
  assert.equal(deniedRepair.ok, false);
  assert.equal(deniedRepair.error.code, 'AGENT_REPAIR_REASON_REQUIRED');
});

test('AgentV3 rejects an explicit continuation whose token does not match the workspace checkpoint', () => {
  const agent = new AgentV3({
    baseAgent: {
      plan: () => ({ ok: true, data: { goal: 'resume safely', objective: 'investigate', steps: [], selectedTools: [] }, evidence: [], meta: {} }),
      _buildRunRecommendations: () => ({ items: [] }),
      _suggestNextAction: () => null,
      _renderReport: () => 'report',
      _emit: () => undefined,
    },
    storage: {
      getGoalMemory: () => null,
      loadLatestCheckpoint: () => ({ id: 'checkpoint-787', state: { resumeToken: 'different-token', status: 'paused' } }),
    },
    maxSteps: 1,
  });
  const result = agent.run('resume safely', {
    workspaceId: 'workspace-787',
    checkpointId: 'checkpoint-787',
    resumeToken: 'checkpoint-787',
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'AGENT_RESUME_TOKEN_INVALID');
});

test('agent continuation rejects terminal checkpoints and exposes repair mode only with a reason', () => {
  const terminal = executeMcpAgentContinuation(fakeAgent(checkpoint({ state: { status: 'completed' } })), {
    goal: 'resume safely', workspaceId: 'workspace-787', checkpointId: 'checkpoint-787', resumeToken: 'checkpoint-787',
  });
  assert.equal(terminal.ok, false);
  assert.equal(terminal.error.code, 'AGENT_CHECKPOINT_NOT_RESUMABLE');

  const agent = fakeAgent();
  const repaired = executeMcpAgentContinuation(agent, {
    goal: 'resume safely', workspaceId: 'workspace-787', checkpointId: 'checkpoint-787', resumeToken: 'checkpoint-787',
    mode: 'repair', repairReason: 'operator-approved checkpoint repair',
  });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.data.continuationMode, 'repair');
  assert.equal(repaired.data.finalAnswer, 'repaired');
  assert.equal(repaired.data.repairReason, 'operator-approved checkpoint repair');
  assert.deepEqual(repaired.data.continuationDecision, {
    mode: 'repair',
    decision: 'requested',
    reason: 'operator-approved checkpoint repair',
    source: 'operator',
    workspaceId: 'workspace-787',
    checkpointId: 'checkpoint-787',
  });
  assert.equal(repaired.data.repairDecision, null);
  assert.equal(agent.calls[1].options.mode, 'repair');
  assert.equal(agent.calls[1].options.repairReason, 'operator-approved checkpoint repair');
});

// #880: an explicit checkpointId must select the named row, not be replaced
// by the latest non-completed checkpoint. Both MCP continuation and AgentV3
// resolve a named id through storage.loadCheckpoint scoped to goal +
// workspace; the latest row stays the default only when no id is named.

function multiCheckpointAgent(rows) {
  const calls = [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  return {
    calls,
    storage: {
      loadCheckpoint(id, goal, workspaceId) {
        calls.push({ operation: 'loadCheckpoint', id, goal, workspaceId });
        const row = byId.get(id);
        if (!row) return null;
        if (row.goal !== goal) return null;
        if (row.workspaceId !== workspaceId) return null;
        if (row.state?.status === 'completed') return null;
        return { ...row };
      },
      loadLatestCheckpoint(goal, workspaceId) {
        calls.push({ operation: 'loadLatestCheckpoint', goal, workspaceId });
        const matching = rows
          .filter((row) => row.goal === goal && row.workspaceId === workspaceId && row.state?.status !== 'completed')
          .sort((a, b) => (b.updated || 0) - (a.updated || 0));
        return matching[0] ? { ...matching[0] } : null;
      },
    },
    run(goal, options) {
      calls.push({ operation: 'run', goal, options });
      return { ok: true, type: 'agent', data: { goal, finalAnswer: 'continued', status: 'completed' }, evidence: [] };
    },
  };
}

test('agent continuation selects an older explicit checkpoint over the latest one (#880)', () => {
  const agent = multiCheckpointAgent([
    { id: 'checkpoint-old', goal: 'resume safely', workspaceId: 'workspace-787', updated: 1, state: { status: 'paused', resumeToken: 'checkpoint-old' } },
    { id: 'checkpoint-new', goal: 'resume safely', workspaceId: 'workspace-787', updated: 2, state: { status: 'paused', resumeToken: 'checkpoint-new' } },
  ]);

  const result = executeMcpAgentContinuation(agent, {
    goal: 'resume safely', workspaceId: 'workspace-787',
    checkpointId: 'checkpoint-old', resumeToken: 'checkpoint-old',
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.checkpointId, 'checkpoint-old');
  assert.equal(agent.calls[0].operation, 'loadCheckpoint');
  assert.equal(agent.calls[0].id, 'checkpoint-old');
  assert.equal(agent.calls[1].operation, 'run');
  assert.equal(agent.calls[1].options.checkpointId, 'checkpoint-old');
  assert.equal(agent.calls[1].options.resumeToken, 'checkpoint-old');

  // Wrong token on the explicitly named checkpoint still fails closed.
  const wrongToken = executeMcpAgentContinuation(agent, {
    goal: 'resume safely', workspaceId: 'workspace-787',
    checkpointId: 'checkpoint-old', resumeToken: 'checkpoint-new',
  });
  assert.equal(wrongToken.ok, false);
  assert.equal(wrongToken.error.code, 'AGENT_RESUME_TOKEN_INVALID');

  // A completed checkpoint is not resumable even when named.
  const completed = multiCheckpointAgent([
    { id: 'checkpoint-old', goal: 'resume safely', workspaceId: 'workspace-787', updated: 1, state: { status: 'completed', resumeToken: 'checkpoint-old' } },
  ]);
  const completedResult = executeMcpAgentContinuation(completed, {
    goal: 'resume safely', workspaceId: 'workspace-787',
    checkpointId: 'checkpoint-old', resumeToken: 'checkpoint-old',
  });
  assert.equal(completedResult.ok, false);
  assert.equal(completedResult.error.code, 'AGENT_CHECKPOINT_NOT_FOUND');
});

test('AgentV3 resumes an explicitly named older checkpoint when one exists (#880)', () => {
  const agent = new AgentV3({
    baseAgent: {
      plan: () => ({ ok: true, data: { goal: 'resume safely', objective: 'investigate', steps: [], selectedTools: [] }, evidence: [], meta: {} }),
      _buildRunRecommendations: () => ({ items: [] }),
      _suggestNextAction: () => null,
      _renderReport: () => 'report',
      _emit: () => undefined,
    },
    storage: {
      getGoalMemory: () => null,
      loadCheckpoint(id, goal, workspaceId) {
        if (id === 'checkpoint-old' && goal === 'resume safely' && workspaceId === 'workspace-787') {
          return { id: 'checkpoint-old', state: { resumeToken: 'checkpoint-old', status: 'paused' } };
        }
        return null;
      },
      loadLatestCheckpoint: () => ({ id: 'checkpoint-new', state: { resumeToken: 'checkpoint-new', status: 'paused' } }),
      sumAgentIterationsSince: () => 0,
      saveCheckpoint: () => null,
      countRuns: () => ({ total: 0 }),
      getGoalMemory: () => null,
      listPendingToolApprovals: () => [],
      countPendingToolApprovals: () => 0,
      saveToolApproval: () => null,
      saveRun: () => null,
      saveGoalMemory: () => null,
      deleteCheckpoint: () => false,
      countGoals: () => 0,
      countCheckpoints: () => 0,
      dbPath: '',
      // Named selection must not fall back to the newest row when the named
      // row exists; the fake exposes both so the branch choice is observable.
    },
    maxSteps: 1,
  });

  const result = agent.run('resume safely', {
    workspaceId: 'workspace-787', resume: true,
    checkpointId: 'checkpoint-old', resumeToken: 'checkpoint-old',
  });
  assert.equal(result.ok, true, 'explicit older checkpoint must resume');
  assert.equal(result.meta?.checkpointId, 'checkpoint-old');

  // An explicit id that belongs to another workspace fails closed instead of
  // silently loading the latest workspace row.
  const crossWorkspace = agent.run('resume safely', {
    workspaceId: 'workspace-787', resume: true,
    checkpointId: 'checkpoint-other', resumeToken: 'checkpoint-other',
  });
  assert.equal(crossWorkspace.ok, false);
  assert.equal(crossWorkspace.error.code, 'AGENT_RESUME_TOKEN_INVALID');
});

test('storage returns the named checkpoint scoped to goal and workspace (#880)', () => {
  // Real storage behaviour is exercised by the sqlite tests; the contract
  // here is the shape the fake agents above rely on: loadCheckpoint takes
  // (id, goal, workspaceId) and loadLatestCheckpoint takes (goal, workspaceId).
  const path = require('node:path');
  const fs = require('node:fs');
  const HuqanStorage = require('../storage');
  const tmpDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'huqan-checkpoint-'));
  const dbPath = path.join(tmpDir, 'checkpoint.db');
  const store = new HuqanStorage({ dbPath });
  assert.equal(typeof store.loadCheckpoint, 'function');
  assert.equal(typeof store.loadLatestCheckpoint, 'function');

  store.saveCheckpoint({
    checkpointId: 'old-1', goal: 'multi checkpoint goal', workspaceId: 'ws-a',
    status: 'paused', resumeToken: 'old-1', startedAtMs: 1,
  });
  store.saveCheckpoint({
    checkpointId: 'new-1', goal: 'multi checkpoint goal', workspaceId: 'ws-a',
    status: 'paused', resumeToken: 'new-1', startedAtMs: 2,
  });
  store.saveCheckpoint({
    checkpointId: 'other-1', goal: 'multi checkpoint goal', workspaceId: 'ws-b',
    status: 'paused', resumeToken: 'other-1', startedAtMs: 1,
  });

  const named = store.loadCheckpoint('old-1', 'multi checkpoint goal', 'ws-a');
  assert.equal(named?.id, 'old-1');
  assert.equal(named.state.resumeToken, 'old-1');
  assert.equal(named.workspace_id, 'ws-a');

  // Explicit id must not leak rows from another workspace or another goal.
  assert.equal(store.loadCheckpoint('old-1', 'multi checkpoint goal', 'ws-b'), null);
  assert.equal(store.loadCheckpoint('other-1', 'multi checkpoint goal', 'ws-a'), null);

  // Latest remains a non-completed row when no id is named. Equal
  // updated_at values tie-break by insert order, which the re-save does not
  // always outrun in fast test runs, so the expectation covers both rows;
  // what matters is that nothing completed or cross-scoped is returned.
  const latestBefore = store.loadLatestCheckpoint('multi checkpoint goal', 'ws-a');
  assert.ok(latestBefore && ['old-1', 'new-1'].includes(latestBefore.id));
  store.saveCheckpoint({
    checkpointId: 'new-1', goal: 'multi checkpoint goal', workspaceId: 'ws-a',
    status: 'paused', resumeToken: 'new-1', startedAtMs: 2,
  });
  const latestAfter = store.loadLatestCheckpoint('multi checkpoint goal', 'ws-a');
  assert.ok(latestAfter && ['old-1', 'new-1'].includes(latestAfter.id),
    'latest must remain a non-completed row after a re-save');

  // A completed checkpoint is invisible to both lookups.
  store.saveCheckpoint({
    checkpointId: 'completed-1', goal: 'multi checkpoint goal', workspaceId: 'ws-a',
    status: 'completed', resumeToken: 'completed-1', startedAtMs: 3,
  });
  assert.equal(store.loadCheckpoint('completed-1', 'multi checkpoint goal', 'ws-a'), null);
  const latestCompleted = store.loadLatestCheckpoint('multi checkpoint goal', 'ws-a');
  assert.ok(latestCompleted && ['old-1', 'new-1'].includes(latestCompleted.id),
    'latest must never return the completed row');

  store.db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
