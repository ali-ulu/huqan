'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const KernelV2 = require('../kernel.v2');
const AgentV3 = require('../agent.v3');
const {
  behavioralBlockResult,
  initializeBehavioralState,
} = require('../lib/agent-behavioral-integrity');

test('behavioral gate blocks connector drift with a scoped containment receipt before execution', () => {
  const state = {
    goal: 'inspect',
    workspaceId: 'ws-alpha',
    agentId: 'agent-v3',
    selectedTools: ['ask'],
    steps: [],
  };
  initializeBehavioralState(state);

  const result = behavioralBlockResult(state, {
    action: 'ask',
    tool: 'ask',
    input: { connector: 'remote' },
  });

  assert.equal(result.error.code, 'BEHAVIORAL_UNEXPECTED_CONNECTOR');
  assert.equal(result.meta.behavioralDecision, 'quarantine');
  assert.equal(result.meta.containment, 'quarantine');
  assert.equal(result.meta.executorSuppressed, true);
  assert.match(result.meta.behavioralReceiptId, /^asi10_/);
  assert.deepEqual(state.behavioralContainmentEvents[0].scope, {
    workspaceId: 'ws-alpha',
    agentId: 'agent-v3',
  });
});

test('canonical AgentV3 stops connector drift before invoking the kernel tool', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-asi10-agent-v3-'));
  const kernel = new KernelV2({
    noLoad: true,
    useSQLite: false,
    loadPlugins: false,
    memoryPath: path.join(tmpDir, 'graph-memory.json'),
  });
  let askCalls = 0;
  kernel.ask = () => {
    askCalls += 1;
    throw new Error('behavioral gate must stop the kernel call');
  };

  const agent = new AgentV3({
    kernel,
    dbPath: path.join(tmpDir, 'agent.db'),
    maxSteps: 1,
    maxIterations: 1,
    timeBudgetMs: 5000,
  });
  agent.baseAgent.plan = (goal) => ({
    ok: true,
    type: 'plan',
    data: {
      goal,
      objective: 'investigate',
      selectedTools: ['ask'],
      maxSteps: 1,
      steps: [{
        id: 'connector-drift',
        action: 'ask',
        tool: 'ask',
        input: { connector: 'remote' },
        rationale: 'test drift',
      }],
      policy: { selectedTools: ['ask'], signals: [] },
      goalIntegrity: null,
    },
    evidence: [],
    meta: {},
  });

  const result = agent.run('inspect', {
    resume: false,
    workspaceId: 'ws-alpha',
    agentId: 'agent-v3',
    maxSteps: 1,
    maxIterations: 1,
    timeBudgetMs: 5000,
  });

  assert.equal(result.ok, false, result.error?.message);
  assert.equal(result.error.code, 'AGENT_BLOCKED');
  assert.equal(result.data.status, 'blocked');
  assert.equal(result.data.steps.length, 1);
  assert.equal(result.data.steps[0].result.error.code, 'BEHAVIORAL_UNEXPECTED_CONNECTOR');
  assert.equal(result.data.steps[0].result.meta.executorSuppressed, true);
  assert.equal(result.data.behavioralContainmentEvents.length, 1);
  assert.equal(result.data.behavioralContainmentEvents[0].scope.workspaceId, 'ws-alpha');
  assert.equal(askCalls, 0);
});

test('behavioral gate contains target, egress, and delegation drift without repair side effects', () => {
  const driftCases = [
    ['targetClass', 'external', 'BEHAVIORAL_UNEXPECTED_TARGET'],
    ['egressClass', 'network', 'BEHAVIORAL_UNEXPECTED_EGRESS'],
    ['delegationClass', 'child-agent', 'BEHAVIORAL_UNEXPECTED_DELEGATION'],
  ];

  for (const [field, value, expectedCode] of driftCases) {
    const state = {
      goal: 'inspect',
      workspaceId: 'ws-alpha',
      agentId: 'agent-v3',
      selectedTools: ['ask'],
      steps: [],
    };
    initializeBehavioralState(state);
    const result = behavioralBlockResult(state, {
      action: 'ask',
      tool: 'ask',
      input: { [field]: value },
    });
    assert.equal(result.error.code, expectedCode);
    assert.equal(result.meta.executorSuppressed, true);
    assert.equal(result.meta.containment, 'quarantine');
    assert.equal(state.behavioralContainmentEvents.length, 1);
  }
});

test('repeated identical production anomalies transition from quarantine to review pause', () => {
  const state = {
    goal: 'inspect',
    workspaceId: 'ws-alpha',
    agentId: 'agent-v3',
    selectedTools: ['ask'],
    steps: [],
  };
  initializeBehavioralState(state);
  const step = { action: 'ask', tool: 'ask', input: { connector: 'remote' } };
  const first = behavioralBlockResult(state, step);
  const second = behavioralBlockResult(state, step);
  const third = behavioralBlockResult(state, step);
  const fourth = behavioralBlockResult(state, step);

  assert.equal(first.meta.behavioralDecision, 'quarantine');
  assert.equal(second.meta.behavioralDecision, 'quarantine');
  assert.equal(third.meta.behavioralDecision, 'quarantine');
  assert.equal(fourth.error.code, 'BEHAVIORAL_REPEATED_ANOMALY');
  assert.equal(fourth.meta.behavioralDecision, 'require_review');
  assert.equal(fourth.meta.containment, 'pause');
  assert.equal(fourth.meta.executorSuppressed, true);
  assert.equal(fourth.meta.approvalDecision, null);
});
