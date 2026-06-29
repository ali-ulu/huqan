const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const KernelV2 = require('./kernel.v2');
const AgentV3 = require('./agent.v3');

const TEST_FIXTURE_LEARN_BYPASS = {
  admissionRequired: false,
  admissionBypassReason: 'test_fixture_seed',
};

function freshAgent(dbPath) {
  const kernel = new KernelV2({ noLoad: true, useSQLite: false, loadPlugins: false });
  kernel.learn('kedi hayvandir', TEST_FIXTURE_LEARN_BYPASS);
  return new AgentV3({ kernel, dbPath, maxSteps: 4, maxIterations: 50, timeBudgetMs: 2000 });
}

describe('AgentV3', () => {
  it('persists a checkpoint and resumes from sqlite', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-agentv3-'));
    const dbPath = path.join(tmpDir, 'memory.db');
    const first = freshAgent(dbPath);

    const firstRun = first.run('kedi hayvandir mi?', {
      resume: false,
      maxIterations: 1,
      timeBudgetMs: 5000,
    });

    assert.strictEqual(firstRun.ok, true);
    assert.strictEqual(firstRun.type, 'agent');
    assert.strictEqual(firstRun.data.status, 'paused');
    assert.ok(firstRun.data.checkpointId);
    assert.ok(firstRun.data.resumeToken);
    assert.ok(firstRun.data.remainingSteps >= 1);

    const checkpoint = first.storage.loadLatestCheckpoint('kedi hayvandir mi?');
    assert.ok(checkpoint);
    assert.strictEqual(checkpoint.id, firstRun.data.checkpointId);

    const resumed = freshAgent(dbPath);
    const secondRun = resumed.run('kedi hayvandir mi?', {
      resume: true,
      maxIterations: 10,
      timeBudgetMs: 5000,
    });

    assert.strictEqual(secondRun.ok, true);
    assert.strictEqual(secondRun.type, 'agent');
    assert.strictEqual(secondRun.data.resumed, true);
    assert.strictEqual(secondRun.data.status, 'completed');
    assert.ok(secondRun.data.completedSteps >= firstRun.data.completedSteps);
    assert.ok(secondRun.data.report.includes('Checkpoint:'));
    assert.ok(secondRun.data.report.includes('Resume:'));
    assert.ok(secondRun.data.report.includes('Sonraki ad'));
    assert.ok(secondRun.data.nextAction);
    assert.ok(secondRun.data.recommendations);

    const goalMemory = resumed.storage.getGoalMemory('kedi hayvandir mi?');
    assert.ok(goalMemory);
    assert.ok(goalMemory.success_count >= 1);
    assert.strictEqual(goalMemory.last_status, 'completed');
  });

  it('surfaces goal memory in plan metadata', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-agentv3-plan-'));
    const dbPath = path.join(tmpDir, 'memory.db');
    const agent = freshAgent(dbPath);
    agent.storage.saveGoalMemory({
      goal: 'kedi hayvandir mi?',
      objective: 'verify',
      status: 'completed',
      completedSteps: 2,
      finalAnswer: 'Kedi hayvandir',
      resumed: false,
      selectedTools: ['ask', 'verify'],
    });

    const plan = agent.plan('kedi hayvandir mi?');
    assert.strictEqual(plan.ok, true);
    assert.ok(plan.data.memory.storage.tracked);
    assert.ok(plan.data.memory.storage.goalMemory.successCount >= 1);
    assert.ok(plan.data.policy.signals.includes('goal-memory'));
  });

  it('getStatus returns default zeros when no runs exist', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-status-zeros-'));
    const dbPath = path.join(tmpDir, 'memory.db');
    const agent = freshAgent(dbPath);
    const status = agent.getStatus();
    assert.ok(status);
    assert.strictEqual(status.goals, 0);
    assert.strictEqual(status.checkpoints, 0);
    assert.strictEqual(status.runs, 0);
    assert.strictEqual(status.lastPlan, null);
    assert.strictEqual(status.lastRun, null);
  });

  it('getStatus returns populated values after a run', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-status-pop-'));
    const dbPath = path.join(tmpDir, 'memory.db');
    const agent = freshAgent(dbPath);
    const result = agent.run('kedi hayvandir mi?', {
      resume: false,
      maxIterations: 1,
      timeBudgetMs: 5000,
    });
    assert.strictEqual(result.ok, true);

    const status = agent.getStatus();
    assert.strictEqual(status.goals, 1);
    assert.ok(status.checkpoints >= 0);
    assert.strictEqual(status.runs, 1);
    assert.ok(status.lastRun);
    assert.strictEqual(status.lastRun.status, 'paused');
  });
});
