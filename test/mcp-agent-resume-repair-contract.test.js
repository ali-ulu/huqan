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
          finalAnswer: 'continued',
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

  const repaired = executeMcpAgentContinuation(fakeAgent(), {
    goal: 'resume safely', workspaceId: 'workspace-787', checkpointId: 'checkpoint-787', resumeToken: 'checkpoint-787',
    mode: 'repair', repairReason: 'operator-approved checkpoint repair',
  });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.data.continuationMode, 'repair');
  assert.equal(repaired.data.repairDecision, 'allow');
});
