'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAgentPlan } = require('../lib/agent-plan-runtime');
const { executeAgentStep } = require('../lib/agent-step-executor');
const { createEmergencyStop, approvalStopAgentId } = require('../lib/emergency-stop');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function runtime(coderExecution) {
  return { agent: { coderExecution }, memory: { goals: [], runs: [], failures: [], toolStats: {} }, maxSteps: 4,
    goalKey: goal => goal, findResumeRun: () => null, emit: () => {}, rememberPlan: () => {},
    ok: (_type, data) => ({ ok: true, data }), setLastPlan: () => {}, setActiveGoal: () => {} };
}
test('only the constructor-owned Coder port supplies a real plan step', () => {
  const step = { id: 'coder:repair', tool: 'coder', action: 'code_change', input: { taskId: 'repair' } };
  const r = runtime({ plan: (goal, workspace) => {
    assert.equal(goal, 'repair value'); assert.equal(workspace, 'default'); return [step];
  } });
  const result = buildAgentPlan({ goal: 'repair value', runtime: r });
  assert.deepEqual(result.data.steps, [step]);
  assert.deepEqual(result.data.selectedTools, ['coder']);
  const ordinary = buildAgentPlan({ goal: 'repair value', opts: { coderExecution: r.agent.coderExecution }, runtime: runtime() });
  assert.ok(ordinary.data.steps.every(row => row.tool !== 'coder'), 'run options cannot install execution authority');
});
test('constructor-owned Coder approval stop cannot be replaced by run options', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-approval-stop-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const emergencyStop = createEmergencyStop({ directory });
  emergencyStop.stop({ scope: 'agent', workspaceId: 'default', agentId: approvalStopAgentId('coder-case'),
    reason: 'operator_cancelled', actor: 'operator' });
  const report = executeAgentStep({ step: { tool: 'coder', action: 'code_change' },
    state: { workspaceId: 'default', agentId: 'agent-v3' }, opts: { emergencyStop, approvalId: 'another-case' },
    runtime: { allowedTools: new Set(), kernel: {}, coderExecution: { approvalId: 'coder-case' },
      emit() { throw new Error('must stop before plugins or Coder'); } } });
  assert.equal(report.status, 'blocked');
  assert.equal(report.result.error.code, 'AGENT_EMERGENCY_STOPPED');
  assert.equal(report.result.meta.emergencyStop.approvalId, 'coder-case');
});
