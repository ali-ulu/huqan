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
 *
 * The third finding -- the base Agent constructed inline in the constructor,
 * recorded as a DIP signal -- is deliberately left as recorded debt: a flat
 * lib/ module is ring-assigned Core, and both candidate homes (the plane it
 * would wrap, agent.js, and lib/storage/) sit outward, so extracting it needs
 * an Application-ring assembly surface first. See the PR body's findings.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Kernel = require('../kernel');
const AgentV3 = require('../agent.v3');
const { normalizeAgentV3WorkspaceId } = require('../lib/agent-v3-workspace');
const { buildGoalMemoryBlock } = require('../lib/agent-v3-plan-memory');
const { goalMemoryKey } = require('../lib/storage/run-state-keys');

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

test('a goal is scoped to the normalized workspace, matching the storage key (#757)', () => {
  const agent = makeAgent();
  try {
    // Whitespace around the id must not create a second workspace.
    const plan = agent.plan('hedef', { workspaceId: '  tenant-a  ' });
    assert.equal(plan.ok, true);
    assert.equal(plan.data.memory.storage.key, goalMemoryKey('hedef', 'tenant-a').split('\u001f')[1]);
  } finally {
    agent.storage.close?.();
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

// lib/agent-v3-plan-memory.js is Core and must not require lib/storage/
// (Adapters), so it repeats the storage key helpers instead of importing them.
// This locks the two copies together: both trim before lowercasing.
test('the plan-memory key helpers stay identical to the storage ones', () => {
  assert.equal(buildGoalMemoryBlock(null, '  Karar  ').key, goalMemoryKey('  Karar  ', 'default').split('\u001f')[1]);
  assert.equal(buildGoalMemoryBlock(null, 'Karar').key, 'karar');
});
