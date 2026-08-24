const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const KernelV2 = require('./kernel.v2');
const AgentV3 = require('./agent.v3');
const Kernel = require('./kernel');

// KernelV2.learn() delegates straight to a wrapped v1 Kernel instance
// (this.kernel.learn()), so it enforces the same admission gate and needs
// the same bypass token (#357).
const TEST_FIXTURE_LEARN_BYPASS = Kernel.createAdmissionBypassOpts('test_fixture_seed');

function freshAgent(dbPath) {
  const kernel = new KernelV2({
    noLoad: true,
    useSQLite: false,
    loadPlugins: false,
    memoryPath: path.join(path.dirname(dbPath), 'memory.json'),
  });
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
    assert.ok(secondRun.data.report.includes('Next step'));
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

  describe('storage error boundaries', () => {
    it('returns the agent error envelope when a resume checkpoint cannot be read', () => {
      const agent = freshAgent(path.join(os.tmpdir(), `axiom-storage-resume-${Date.now()}.db`));
      agent.storage.loadLatestCheckpoint = () => { throw new Error('sqlite resume unavailable'); };

      const result = agent.run('kedi hayvandir mi?');

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error.code, 'AGENT_STORAGE_ERROR');
      assert.strictEqual(result.meta.operation, 'loadLatestCheckpoint');
    });

    it('returns the agent error envelope when the initial checkpoint cannot be saved', () => {
      const agent = freshAgent(path.join(os.tmpdir(), `axiom-storage-checkpoint-${Date.now()}.db`));
      agent.storage.saveCheckpoint = () => { throw new Error('sqlite checkpoint unavailable'); };

      const result = agent.run('kedi hayvandir mi?', { resume: false, maxIterations: 1 });

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.type, 'agent');
      assert.strictEqual(result.error.code, 'AGENT_STORAGE_ERROR');
      assert.strictEqual(result.meta.operation, 'saveCheckpoint');
      assert.ok(result.data);
      assert.strictEqual(result.data.iteration, 0);
    });

    it('returns the agent error envelope when final memory cannot be read', () => {
      const agent = freshAgent(path.join(os.tmpdir(), `axiom-storage-memory-${Date.now()}.db`));
      const getGoalMemory = agent.storage.getGoalMemory.bind(agent.storage);
      let calls = 0;
      agent.storage.getGoalMemory = (...args) => {
        calls += 1;
        if (calls > 1) throw new Error('sqlite memory unavailable');
        return getGoalMemory(...args);
      };

      const result = agent.run('kedi hayvandir mi?', { resume: false, maxIterations: 1 });

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error.code, 'AGENT_STORAGE_ERROR');
      assert.strictEqual(result.meta.operation, 'readRunMemory');
      assert.ok(result.data);
    });

    it('returns the agent error envelope when the run cannot be persisted', () => {
      const agent = freshAgent(path.join(os.tmpdir(), `axiom-storage-run-${Date.now()}.db`));
      agent.storage.saveRun = () => { throw new Error('sqlite run unavailable'); };

      const result = agent.run('kedi hayvandir mi?', { resume: false, maxIterations: 1 });

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error.code, 'AGENT_STORAGE_ERROR');
      assert.strictEqual(result.meta.operation, 'saveRun');
      assert.ok(result.data);
    });

    it('returns the agent error envelope when goal memory cannot be persisted', () => {
      const agent = freshAgent(path.join(os.tmpdir(), `axiom-storage-goal-${Date.now()}.db`));
      agent.storage.saveGoalMemory = () => { throw new Error('sqlite goal unavailable'); };

      const result = agent.run('kedi hayvandir mi?', { resume: false, maxIterations: 1 });

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error.code, 'AGENT_STORAGE_ERROR');
      assert.strictEqual(result.meta.operation, 'saveGoalMemory');
      assert.ok(result.data);
    });

    it('keeps loop-budget storage failures fail-closed', () => {
      const agent = freshAgent(path.join(os.tmpdir(), `axiom-storage-budget-${Date.now()}.db`));
      agent.storage.sumAgentIterationsSince = () => { throw new Error('sqlite budget unavailable'); };

      const result = agent.run('kedi hayvandir mi?', { resume: false, maxIterations: 1 });

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error.code, 'AGENT_LOOP_BUDGET_UNAVAILABLE');
      assert.strictEqual(result.meta.gate, 'AB10');
      assert.strictEqual(result.meta.budget.usageKnown, false);
    });

    it('returns the agent error envelope when a completed checkpoint cannot be deleted', () => {
      const agent = freshAgent(path.join(os.tmpdir(), `axiom-storage-delete-${Date.now()}.db`));
      agent.storage.deleteCheckpoint = () => { throw new Error('sqlite cleanup unavailable'); };

      const result = agent.run('kedi hayvandir mi?', { resume: false, maxIterations: 10 });

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error.code, 'AGENT_STORAGE_ERROR');
      assert.strictEqual(result.meta.operation, 'deleteCheckpoint');
      assert.ok(result.data);
    });
  });

  describe('loop budget accounting across resume', () => {
    it('counts a resumed run once, not cumulatively', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-ab10-resume-'));
      const dbPath = path.join(tmpDir, 'memory.db');
      const agent = freshAgent(dbPath);
      const goal = 'kedi hayvandir mi?';
      const since = Date.now() - 60_000;

      // First pass: spend one iteration and pause.
      agent.run(goal, { resume: false, maxIterations: 1, timeBudgetMs: 5000, workspaceId: 'ws-a' });
      const afterFirst = agent.storage.sumAgentIterationsSince('ws-a', since);

      // Resume and spend more. state.iteration is cumulative across resumes,
      // so a naive sum of it would charge the first iteration twice.
      const resumed = freshAgent(dbPath);
      resumed.run(goal, { maxIterations: 3, timeBudgetMs: 5000, workspaceId: 'ws-a' });
      const afterResume = resumed.storage.sumAgentIterationsSince('ws-a', since);

      const spentOnResume = afterResume - afterFirst;
      assert.ok(spentOnResume >= 0, 'usage must not go backwards');
      assert.ok(afterResume <= 3,
        `resumed usage should reflect real iterations, got ${afterResume} (cumulative double-count would exceed this)`);
    });

    it('keeps usage scoped to its own workspace', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-ab10-scope-'));
      const dbPath = path.join(tmpDir, 'memory.db');
      const agent = freshAgent(dbPath);
      const since = Date.now() - 60_000;

      agent.run('kedi hayvandir mi?', { resume: false, maxIterations: 1, timeBudgetMs: 5000, workspaceId: 'ws-a' });

      assert.ok(agent.storage.sumAgentIterationsSince('ws-a', since) >= 0);
      assert.strictEqual(agent.storage.sumAgentIterationsSince('ws-b', since), 0,
        'another workspace must not inherit this usage');
    });

    it('falls back to the cumulative figure when no delta is supplied', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-ab10-fallback-'));
      const dbPath = path.join(tmpDir, 'memory.db');
      const agent = freshAgent(dbPath);
      const since = Date.now() - 60_000;

      // Direct seeding (no iterationsDelta) keeps working, so existing
      // callers and fixtures are unaffected by the new column.
      agent.storage.saveRun({
        goal: 'seed run',
        status: 'completed',
        iteration: 7,
        workspaceId: 'ws-seed',
        startedAtMs: Date.now(),
      });

      assert.strictEqual(agent.storage.sumAgentIterationsSince('ws-seed', since), 7);
    });
  });

  describe('checkpoint workspace isolation', () => {
    it('does not resume another workspace\'s paused checkpoint for the same goal', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-ckpt-ws-'));
      const dbPath = path.join(tmpDir, 'memory.db');
      const agent = freshAgent(dbPath);
      const goal = 'kedi hayvandir mi?';

      // Pause a run in ws-a so a checkpoint exists for this goal.
      agent.run(goal, { resume: false, maxIterations: 1, timeBudgetMs: 5000, workspaceId: 'ws-a' });
      const paused = agent.storage.loadLatestCheckpoint(goal, 'ws-a');
      assert.ok(paused, 'ws-a should have a checkpoint for this goal');

      // The same goal in ws-b must not see it.
      assert.strictEqual(agent.storage.loadLatestCheckpoint(goal, 'ws-b'), null,
        'a checkpoint must not be visible from another workspace');
    });

    it('scopes a saved checkpoint to the run workspace', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-ckpt-scope-'));
      const dbPath = path.join(tmpDir, 'memory.db');
      const agent = freshAgent(dbPath);
      const goal = 'kedi hayvandir mi?';

      agent.run(goal, { resume: false, maxIterations: 1, timeBudgetMs: 5000, workspaceId: 'ws-a' });

      const row = agent.storage.loadLatestCheckpoint(goal, 'ws-a');
      assert.ok(row);
      assert.strictEqual(row.workspace_id, 'ws-a');
    });

    it('defaults an unscoped lookup to the default workspace', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-ckpt-default-'));
      const dbPath = path.join(tmpDir, 'memory.db');
      const agent = freshAgent(dbPath);
      const goal = 'kedi hayvandir mi?';

      agent.run(goal, { resume: false, maxIterations: 1, timeBudgetMs: 5000 });

      assert.ok(agent.storage.loadLatestCheckpoint(goal), 'omitted workspace reads the default workspace');
      assert.ok(agent.storage.loadLatestCheckpoint(goal, 'default'));
      assert.strictEqual(agent.storage.loadLatestCheckpoint(goal, 'ws-a'), null);
    });
  });

  describe('AB10 agent loop budget gate', () => {
    it('blocks a run when the workspace already exhausted its window budget, without executing any step', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-ab10-block-'));
      const dbPath = path.join(tmpDir, 'memory.db');
      const agent = freshAgent(dbPath);
      agent.maxIterationsPerWindow = 10;

      // Pre-seed durable usage above the ceiling for this workspace.
      agent.storage.saveRun({
        goal: 'seed run',
        status: 'completed',
        iteration: 10,
        workspaceId: 'ws-a',
        startedAtMs: Date.now(),
      });

      const result = agent.run('kedi hayvandir mi?', {
        resume: false,
        maxIterations: 5,
        timeBudgetMs: 5000,
        workspaceId: 'ws-a',
      });

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error.code, 'AGENT_LOOP_BUDGET_EXCEEDED');
      assert.strictEqual(result.meta.gate, 'AB10');
      assert.strictEqual(result.meta.budget.decision, 'block');
      // No checkpoint means the loop never started. Look in the run's own
      // workspace: checkpoints are workspace-scoped, so checking 'default'
      // here would read null whether or not ws-a had written one.
      assert.strictEqual(agent.storage.loadLatestCheckpoint('kedi hayvandir mi?', 'ws-a'), null);

      const auditEvents = agent.kernel.graph.getAuditEvents({ workspaceId: 'ws-a' });
      assert.ok(auditEvents.some(ev => ev.targetType === 'agent_loop_budget' && ev.details.gate === 'AB10'));
    });

    it('does not block a different workspace (isolation)', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-ab10-isolation-'));
      const dbPath = path.join(tmpDir, 'memory.db');
      const agent = freshAgent(dbPath);
      agent.maxIterationsPerWindow = 10;

      agent.storage.saveRun({
        goal: 'seed run',
        status: 'completed',
        iteration: 10,
        workspaceId: 'ws-a',
        startedAtMs: Date.now(),
      });

      const result = agent.run('kedi hayvandir mi?', {
        resume: false,
        maxIterations: 1,
        timeBudgetMs: 5000,
        workspaceId: 'ws-b',
      });

      assert.strictEqual(result.ok, true);
      assert.notStrictEqual(result.data.status, undefined);
    });

    it('allows a fresh workspace with no prior usage to run normally', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-ab10-fresh-'));
      const dbPath = path.join(tmpDir, 'memory.db');
      const agent = freshAgent(dbPath);

      const result = agent.run('kedi hayvandir mi?', {
        resume: false,
        maxIterations: 1,
        timeBudgetMs: 5000,
        workspaceId: 'ws-fresh',
      });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.data.status, 'paused');
    });
  });
});
