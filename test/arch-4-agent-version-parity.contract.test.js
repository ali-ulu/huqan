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
const AxiomStorage = require('../storage');
const Kernel = require('../kernel');

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
      const storage = new AxiomStorage({ kernel: k, dbPath: path.join(root, 'v1.db') });
      closeables.push(storage);
      return new Agent({ kernel: k, storage });
    },
    v3() {
      const k = kernel('v3');
      const agent = new AgentV3({ kernel: k, dbPath: path.join(root, 'v3.db') });
      closeables.push(agent.storage);
      return agent;
    },
  };
}

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

  assert.equal(custom.baseAgent, injected);
  assert.equal(custom.baseAgent.storage, null);
});
