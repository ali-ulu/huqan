'use strict';

/**
 * agent.v3.js review findings (deep-review queue #3).
 *
 *  - plan() read goal memory without a guard, so a storage failure escaped
 *    plan() -- and therefore run(), which calls plan() first -- as a raw
 *    exception while every other storage call in the class returned a
 *    structured AGENT_STORAGE_ERROR.
 *  - plan() passed opts.workspaceId to storage raw while run() normalized it,
 *    so a non-string id failed with a TypeError from inside the store rather
 *    than a structured refusal, and the two entry points could disagree on a
 *    blank id.
 *  - the base agent was constructed inline in the constructor, which the
 *    architecture tracker recorded as a DIP coupling. It now comes from
 *    lib/agent-v3-base-agent-factory.js (a registered composition root).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Kernel = require('../kernel');
const AgentV3 = require('../agent.v3');
const { createDefaultAgentV3BaseAgent } = require('../lib/agent-v3-base-agent-factory');
const { normalizeAgentV3WorkspaceId } = require('../lib/agent-v3-workspace');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-agent-v3-harden-'));
test.after(() => {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
});

let seq = 0;
function makeKernel() {
  seq += 1;
  return new Kernel({
    noLoad: true,
    loadPlugins: false,
    useSQLite: false,
    memoryPath: path.join(tempDir, `k${seq}.json`),
    capabilities: { companyMode: true, pluginCapabilities: true, evidenceRanking: true },
  });
}

function makeAgent() {
  seq += 1;
  return new AgentV3({ kernel: makeKernel(), dbPath: path.join(tempDir, `a${seq}.db`) });
}

test('plan() converts a storage read failure into AGENT_STORAGE_ERROR instead of throwing', () => {
  const agent = makeAgent();
  agent.storage.getGoalMemory = () => { throw new Error('disk went away'); };
  try {
    const result = agent.plan('gizli hedef', {});
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'AGENT_STORAGE_ERROR');
    assert.match(result.error.message, /getGoalMemory/);
  } finally {
    agent.storage.close?.();
  }
});

test('run() surfaces the same storage failure of plan() structurally', () => {
  const agent = makeAgent();
  agent.storage.getGoalMemory = () => { throw new Error('disk gone'); };
  try {
    const result = agent.run('hedef', { maxSteps: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'AGENT_STORAGE_ERROR');
  } finally {
    agent.storage.close?.();
  }
});

test('plan() and run() refuse a non-string workspaceId the same way, not with a TypeError', () => {
  for (const entry of ['plan', 'run']) {
    const agent = makeAgent();
    try {
      const result = agent[entry]('hedef', { workspaceId: 123, maxSteps: 1 });
      assert.equal(result.ok, false, `${entry} must fail structurally`);
      assert.equal(result.error.code, 'AGENT_WORKSPACE_ID_INVALID', `${entry}`);
    } finally {
      agent.storage.close?.();
    }
  }
});

test('normalizeAgentV3WorkspaceId mirrors lib/workspace-id.js policy', () => {
  for (const blank of [undefined, null, '', '   ']) {
    assert.deepEqual(normalizeAgentV3WorkspaceId(blank), { ok: true, workspaceId: 'default' }, String(blank));
  }
  assert.deepEqual(normalizeAgentV3WorkspaceId('  tenant-a  '), { ok: true, workspaceId: 'tenant-a' });
  assert.equal(normalizeAgentV3WorkspaceId(123).ok, false);
  assert.equal(normalizeAgentV3WorkspaceId({}).ok, false);
});

test('the base-agent factory builds the storage-less Agent v3 wraps, and an injected one still wins', () => {
  const kernel = makeKernel();
  const built = createDefaultAgentV3BaseAgent({ kernel, dream: null, maxSteps: 4, storage: null });
  assert.equal(built.storage, null, 'the base agent must not reach v1 run/goal-memory persistence');

  const agent = new AgentV3({ kernel, storage: null, dbPath: path.join(tempDir, 'seam.db') });
  const injected = { plan: () => ({ ok: true, data: {}, evidence: [], meta: {} }) };
  const custom = new AgentV3({ kernel, baseAgent: injected, dbPath: path.join(tempDir, 'injected.db') });
  try {
    assert.equal(custom.baseAgent, injected, 'an injected baseAgent must be left exactly as built');
    assert.notEqual(agent.baseAgent, injected);
  } finally {
    agent.storage.close?.();
    custom.storage.close?.();
  }
});
