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

test('queued Coder step uses its own approval stop after reordering', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-queue-stop-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const emergencyStop = createEmergencyStop({ directory });
  emergencyStop.stop({ scope: 'agent', workspaceId: 'default', agentId: approvalStopAgentId('second-case'),
    reason: 'operator_cancelled', actor: 'operator' });
  const report = executeAgentStep({ step: { id: 'coder:second', tool: 'coder', action: 'code_change' },
    state: { workspaceId: 'default', agentId: 'agent-v3' }, opts: { emergencyStop, approvalId: 'first-case' },
    runtime: { allowedTools: new Set(), kernel: {}, coderExecution: { approvalIdFor: step => step.id === 'coder:second' ? 'second-case' : 'first-case' },
      emit() { throw new Error('stopped queued case reached plugins'); } } });
  assert.equal(report.status, 'blocked');
  assert.equal(report.result.meta.emergencyStop.approvalId, 'second-case');
});

test('#4065 the Coder work kind stays within the cognition action-class limit', () => {
  const { workKindFor } = require('../lib/agent-coder-execution');
  const project = families => ({ operation: { type: 'initialize_project',
    spec: { routes: families.map(family => ({ compute: { family } })) } } });
  assert.equal(workKindFor(project(['array-map'])), 'initialize_project:array-map');
  assert.equal(workKindFor(project(['array-map', 'array-filter', 'array-map'])), 'initialize_project:array-filter+array-map');
  assert.equal(workKindFor({ operation: { type: 'replace_text' } }), 'replace_text');
  const many = ['array-fold', 'array-guarded-fold', 'array-threshold-fold', 'array-stateful-fold', 'array-map', 'array-filter'];
  const long = workKindFor(project(many));
  assert.ok(`coder:${long}`.length <= 64, long);
  assert.match(long, /^initialize_project:[0-9a-f]{16}$/u);
  assert.equal(workKindFor(project([...many].reverse())), long, 'the digest does not depend on route order');
});
