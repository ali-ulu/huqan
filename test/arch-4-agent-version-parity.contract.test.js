'use strict';

/**
 * #329 (arch-4), agent side. agentRuntime.createAgent() hands callers either
 * Agent (agent.js) or AgentV3 (agent.v3.js) from a single env var
 * (HUQAN_AGENT_VERSION). AgentV3 wraps an internal `baseAgent` rather than
 * extending Agent, and it deliberately builds that baseAgent *without*
 * storage: plan() and the step executors share the same instance, so handing
 * it a full storage object would switch on agent.js's own saveRun() and
 * saveGoalMemory() paths underneath v3, which owns that persistence itself.
 *
 * The cost of that decision was a governance hole. Agent.inspectToolPolicy()
 * records the approval through this.storage.saveToolApproval(), so with a
 * storage-less baseAgent the v3 approval gate silently recorded nothing:
 * approvalId and approvalStatus came back null, no pending approval was
 * persisted, and Agent's listPendingToolApprovals()/countPendingToolApprovals()
 * did not exist on v3 at all. An operator running v3 saw a "review" verdict
 * with no durable trace of what needed reviewing.
 *
 * These tests lock three separate things:
 *
 *   1. The approval record is persisted under v3, through v3's own storage.
 *   2. The pending-approval read surface exists on v3.
 *   3. baseAgent still cannot reach the v1 run/goal-memory persistence paths.
 *      This is the regression guard on the fix itself -- passing the whole
 *      storage object would satisfy (1) and (2) while silently changing what
 *      v3 writes on every plan() and run().
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Agent = require('../agent');
const AgentV3 = require('../agent.v3');
const HuqanStorage = require('../storage');
const Kernel = require('../kernel');
const KernelV2 = require('../kernel.v2');
const { createAgent, CANONICAL_AGENT_VERSION } = require('../agentRuntime');

const EXTERNAL_REVIEW_TOOL = 'http-fetch';
const EXTERNAL_REVIEW_INPUT = 'https://example.com/data';
const EXTERNAL_BLOCKED_TOOL = 'shell-exec';

function publicMethods(ctor) {
  return Object.getOwnPropertyNames(ctor.prototype)
    .filter((name) => name !== 'constructor' && !name.startsWith('_'))
    .sort();
}

function fixture(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `huqan-arch4-agent-${label}-`));
  const closeables = [];
  t.after(() => {
    for (const item of closeables) {
      try { item.close?.(); } catch (_) {}
      try { item.graph?.close?.(); } catch (_) {}
      try { item.memory?.close?.(); } catch (_) {}
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function kernel(name) {
    const instance = new Kernel({
      noLoad: true,
      useSQLite: false,
      loadPlugins: false,
      memoryPath: path.join(root, `${name}.json`),
      dbPath: path.join(root, `${name}-graph.db`),
    });
    closeables.push(instance);
    return instance;
  }

  return {
    v1() {
      const k = kernel('v1');
      const storage = new HuqanStorage({ kernel: k, dbPath: path.join(root, 'v1.db') });
      closeables.push(storage);
      return new Agent({ kernel: k, storage });
    },
    v3() {
      const k = kernel('v3');
      const agent = new AgentV3({ kernel: k, dbPath: path.join(root, 'v3.db') });
      closeables.push(agent.storage);
      return agent;
    },
    viaRuntime(opts = {}) {
      const k = kernel(`runtime-${closeables.length}`);
      const agent = createAgent({
        kernel: k,
        dbPath: path.join(root, `runtime-${closeables.length}.db`),
        ...opts,
      });
      if (agent && agent.storage) closeables.push(agent.storage);
      return agent;
    },
  };
}

test('the agent runtime always builds the canonical agent', (t) => {
  const f = fixture(t, 'canonical');
  const implicit = f.viaRuntime({});
  const explicit = f.viaRuntime({ version: CANONICAL_AGENT_VERSION });
  const blank = f.viaRuntime({ version: '' });

  for (const agent of [implicit, explicit, blank]) {
    assert.equal(agent instanceof AgentV3, true);
    assert.equal(agent instanceof Agent, false, 'AgentV3 wraps Agent, it does not extend it');
  }
});

test('a legacy agent version request fails fast instead of selecting agent.js', (t) => {
  const f = fixture(t, 'legacy-version');
  for (const version of ['v1', 'v2', 'classic', 'V4']) {
    assert.throws(
      () => f.viaRuntime({ version }),
      (error) => error.code === 'HUQAN_AGENT_VERSION_UNSUPPORTED' && error.requested === version,
      `version=${version} must fail closed`,
    );
  }
});

test('a legacy agent version in the environment fails fast', (t) => {
  const f = fixture(t, 'legacy-env');
  const had = Object.prototype.hasOwnProperty.call(process.env, 'HUQAN_AGENT_VERSION');
  const previous = process.env.HUQAN_AGENT_VERSION;
  t.after(() => {
    if (had) process.env.HUQAN_AGENT_VERSION = previous;
    else delete process.env.HUQAN_AGENT_VERSION;
  });

  process.env.HUQAN_AGENT_VERSION = 'v2';
  assert.throws(() => f.viaRuntime({}), { code: 'HUQAN_AGENT_VERSION_UNSUPPORTED' });

  process.env.HUQAN_AGENT_VERSION = CANONICAL_AGENT_VERSION;
  assert.equal(f.viaRuntime({}) instanceof AgentV3, true, 'the canonical value stays accepted');
});

test('the workflow runtime axis is untouched by the version decision', (t) => {
  const f = fixture(t, 'workflow-axis');
  const workflow = f.viaRuntime({ runtime: 'workflow' });

  // runtime=workflow selects between the agent loop and the workflow runtime,
  // which is a different question from which agent version runs. It must keep
  // working, and it must still reject a removed version selector.
  assert.equal(workflow instanceof AgentV3, false);
  assert.notEqual(workflow, null);
  assert.throws(
    () => f.viaRuntime({ runtime: 'workflow', version: 'v2' }),
    { code: 'HUQAN_AGENT_VERSION_UNSUPPORTED' },
  );
});

/**
 * #329: afterAgentRun was emitted only by agent.js's run(), and AgentV3 runs
 * its own loop, so making AgentV3 canonical silenced the two plugins that
 * subscribe to it (plugins/daily-digest.js, plugins/workspace-sync.js).
 *
 * The hook is restored on AgentV3 with terminal semantics, matching what the
 * agent.js contract actually meant: it fires after the final state is built
 * and persisted, so it says "an agent run reached a conclusion", not "a run()
 * call returned". AgentV3's `paused` is a genuine intermediate state --
 * checkpointed and resumable -- and must stay silent, because daily-digest
 * counts only `blocked` separately and buckets everything else as
 * runsCompleted; a paused emit would quietly inflate that number.
 */
function emitProbe(t, label, { maxSteps = 1 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `huqan-arch4-emit-${label}-`));
  const kernel = new KernelV2({ noLoad: true, useSQLite: false, loadPlugins: false });
  kernel.learn('kedi hayvandir', Kernel.createAdmissionBypassOpts('test_fixture_seed'));

  const beforeSeen = [];
  const seen = [];
  kernel.usePlugin({
    name: `emit-probe-${label}`,
    beforeAgentRun(_kernel, state) { beforeSeen.push(state); },
    afterAgentRun(_kernel, state) { seen.push(state); },
  });

  const agent = new AgentV3({
    kernel,
    dbPath: path.join(root, 'agent.db'),
    maxSteps,
    maxIterations: 200,
    timeBudgetMs: 8000,
  });

  t.after(() => {
    try { agent.storage?.close?.(); } catch (_) {}
    try { kernel.graph?.close?.(); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  return { agent, beforeSeen, seen, maxSteps };
}

const EMIT_GOAL = 'kedi hayvandir mi?';

test('a completed run emits afterAgentRun exactly once', (t) => {
  const probe = emitProbe(t, 'completed', { maxSteps: 1 });
  const result = probe.agent.run(EMIT_GOAL, {
    resume: false,
    maxSteps: 1,
    maxIterations: 200,
    timeBudgetMs: 8000,
    workspaceId: 'ws-completed',
  });

  assert.equal(result.data.status, 'completed');
  assert.equal(probe.beforeSeen.length, 1);
  assert.equal(probe.seen.length, 1);
});

test('a blocked run emits afterAgentRun exactly once', (t) => {
  const probe = emitProbe(t, 'blocked', { maxSteps: 1 });
  probe.agent.baseAgent._executeStepWithRetry = () => ({
    status: 'blocked',
    tool: 'shell-exec',
    result: { ok: false, error: { code: 'BLOCKED', message: 'refused' } },
  });

  const result = probe.agent.run(EMIT_GOAL, {
    resume: false,
    maxSteps: 1,
    maxIterations: 200,
    timeBudgetMs: 8000,
    workspaceId: 'ws-blocked',
  });

  assert.equal(result.ok, false);
  assert.equal(probe.beforeSeen.length, 1);
  assert.equal(probe.seen.length, 1);
  assert.equal(probe.seen[0].status, 'blocked');
});

test('a paused run emits afterAgentRun zero times', (t) => {
  const probe = emitProbe(t, 'paused', { maxSteps: 4 });
  const result = probe.agent.run(EMIT_GOAL, {
    resume: false,
    maxIterations: 1,
    timeBudgetMs: 5000,
    workspaceId: 'ws-paused',
  });

  assert.equal(result.data.status, 'paused');
  assert.equal(probe.beforeSeen.length, 1, 'beforeAgentRun observes a resumable run attempt');
  assert.equal(probe.seen.length, 0, 'a resumable checkpoint is not a concluded run');
});

test('beforeAgentRun fires before a durable budget refusal', (t) => {
  const probe = emitProbe(t, 'budget-refused', { maxSteps: 1 });
  probe.agent.storage.sumAgentIterationsSince = () => 1;
  const result = probe.agent.run(EMIT_GOAL, {
    resume: false,
    maxSteps: 1,
    maxIterations: 200,
    maxIterationsPerWindow: 1,
    timeBudgetMs: 8000,
    workspaceId: 'ws-budget-refused',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'AGENT_LOOP_BUDGET_EXCEEDED');
  assert.equal(probe.beforeSeen.length, 1, 'the before hook observes the refused attempt');
  assert.equal(probe.beforeSeen[0].workspaceId, 'ws-budget-refused');
  assert.equal(probe.seen.length, 0, 'no terminal hook fires when the run never starts');
});

test('the emitted state keeps the v3 workspaceId the run was scoped to', (t) => {
  const probe = emitProbe(t, 'workspace', { maxSteps: 1 });
  probe.agent.run(EMIT_GOAL, {
    resume: false,
    maxSteps: 1,
    maxIterations: 200,
    timeBudgetMs: 8000,
    workspaceId: 'ws-scoped',
  });

  assert.equal(probe.beforeSeen.length, 1);
  assert.equal(probe.seen.length, 1);
  // plugins/workspace-sync.js reads state.workspaceId directly when present,
  // so v3's run state is strictly better input than agent.js ever produced.
  assert.equal(probe.seen[0].workspaceId, 'ws-scoped');
});

test('afterAgentRun fires after the run is persisted, not before', (t) => {
  const probe = emitProbe(t, 'ordering', { maxSteps: 1 });
  probe.agent.run(EMIT_GOAL, {
    resume: false,
    maxSteps: 1,
    maxIterations: 200,
    timeBudgetMs: 8000,
    workspaceId: 'ws-order',
  });

  assert.equal(probe.beforeSeen.length, 1);
  assert.equal(probe.seen.length, 1);
  // agent.js emits after _rememberRun(); the v3 emit sits after saveRun /
  // saveGoalMemory / deleteCheckpoint, so a subscriber observing storage sees
  // a settled run rather than a half-written one.
  assert.equal(probe.agent.storage.countRuns() >= 1, true);
  assert.equal(probe.agent.lastRun, probe.seen[0]);
});

test('every Agent public prototype method is reachable through AgentV3', () => {
  const v1 = publicMethods(Agent);
  const v3 = new Set(publicMethods(AgentV3));
  const missing = v1.filter((name) => !v3.has(name));
  assert.deepEqual(missing, [], `AgentV3 does not expose: ${missing.join(', ')}`);
});

test('v3 persists the approval record for a tool that requires review', (t) => {
  const f = fixture(t, 'persist');
  const agent = f.v3();

  const result = agent.inspectToolPolicy(EXTERNAL_REVIEW_TOOL, EXTERNAL_REVIEW_INPUT, { goal: 'fetch' });

  assert.equal(result.data.category, 'external');
  assert.equal(result.data.action, 'review');
  assert.equal(typeof result.data.approvalId, 'string');
  assert.equal(result.data.approvalStatus, 'pending');
  assert.equal(result.meta.approvalId, result.data.approvalId);

  // The record must land in v3's own storage, not be dropped on the floor.
  assert.equal(agent.storage.countPendingToolApprovals(), 1);
  const pending = agent.storage.listPendingToolApprovals(10);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, result.data.approvalId);
  assert.equal(pending[0].tool, EXTERNAL_REVIEW_TOOL);
});

test('v3 exposes the pending-approval read surface', (t) => {
  const f = fixture(t, 'read-surface');
  const agent = f.v3();
  agent.inspectToolPolicy(EXTERNAL_REVIEW_TOOL, EXTERNAL_REVIEW_INPUT, { goal: 'fetch' });

  assert.equal(agent.countPendingToolApprovals(), 1);
  const pending = agent.listPendingToolApprovals(10);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].tool, EXTERNAL_REVIEW_TOOL);
});

test('v1 and v3 agree on the approval verdict for the same tool call', (t) => {
  const f = fixture(t, 'verdict-parity');
  const v1 = f.v1();
  const v3 = f.v3();

  for (const [tool, input, expectedAction, expectedStatus] of [
    [EXTERNAL_REVIEW_TOOL, EXTERNAL_REVIEW_INPUT, 'review', 'pending'],
    [EXTERNAL_BLOCKED_TOOL, 'rm -rf /', 'block', 'blocked'],
  ]) {
    const a = v1.inspectToolPolicy(tool, input, { goal: 'g' });
    const b = v3.inspectToolPolicy(tool, input, { goal: 'g' });
    assert.equal(a.data.action, expectedAction, `v1 ${tool}`);
    assert.equal(b.data.action, expectedAction, `v3 ${tool}`);
    assert.equal(a.data.category, b.data.category);
    assert.equal(a.data.approvalStatus, expectedStatus, `v1 ${tool} status`);
    assert.equal(b.data.approvalStatus, expectedStatus, `v3 ${tool} status`);
  }
});

test('an internal tool records no approval under v3', (t) => {
  const f = fixture(t, 'internal');
  const agent = f.v3();

  const result = agent.inspectToolPolicy('verify', 'Ali bir mühendistir');
  assert.equal(result.data.category, 'internal');
  assert.equal(result.data.approvalId, null);
  assert.equal(agent.countPendingToolApprovals(), 0);
});

test('the baseAgent seam carries approval persistence and nothing else', (t) => {
  const f = fixture(t, 'seam');
  const agent = f.v3();

  // The whole point of the seam: baseAgent must be able to persist an
  // approval, and must NOT be able to reach the v1 run / goal-memory paths
  // that agent.js guards with `typeof this.storage.X === 'function'`.
  assert.equal(typeof agent.baseAgent.storage.saveToolApproval, 'function');
  for (const forbidden of ['saveRun', 'saveGoalMemory', 'getGoalMemory', 'countRuns', 'saveCheckpoint']) {
    assert.equal(
      typeof agent.baseAgent.storage[forbidden],
      'undefined',
      `baseAgent must not reach storage.${forbidden}`,
    );
  }

  // And the seam must not be the same object as v3's storage, which does
  // expose those methods for v3's own use.
  assert.notEqual(agent.baseAgent.storage, agent.storage);
  assert.equal(typeof agent.storage.saveRun, 'function');
});

test('an injected baseAgent is left exactly as the caller built it', (t) => {
  const f = fixture(t, 'injected');
  const agent = f.v3();
  const injected = new Agent({ kernel: agent.kernel });
  const custom = new AgentV3({ kernel: agent.kernel, baseAgent: injected, dbPath: agent.storage.dbPath });

  try {
    assert.equal(custom.baseAgent, injected);
    assert.equal(custom.baseAgent.storage, null);
  } finally {
    // custom.storage opens its own SQLite handle on the same dbPath as
    // agent.storage. It must be closed here, synchronously, before
    // returning: fixture()'s t.after was registered during setup (before
    // this test body ran) and Node runs `after` hooks in registration
    // order (FIFO), so it fires -- and rmSync's the temp dir -- before any
    // `t.after` this test registers now. Left open, it is a leaked handle
    // that blocks that cleanup on Windows (EPERM).
    try { custom.storage?.close?.(); } catch (_) {}
  }
});
