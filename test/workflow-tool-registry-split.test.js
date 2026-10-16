'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

// #2132 (#2122): workflow-agent.js held four jobs in 941 lines. The tool
// registry (tool records, policy + firewall gating, output normalisation), the
// value normalisers it shares with the agent, and the unforgeable external-
// review approval token move to lib/ unchanged, and workflow-agent.js re-exports
// them. The first block pins the registry's whole status matrix, the exported
// normalisers and an end-to-end run to digests recorded on main.

// harness:start
const WorkflowAgent = require('../workflow-agent');
const { ToolRegistry, createExternalReviewApproval, registerReceiverOwnedTool } = WorkflowAgent;

async function registryMatrix() {
  const registry = new ToolRegistry();
  registry.registerTool({ name: 'ask', description: 'internal ask', run: (ctx, input) => ({ ok: true, data: { answer: 'a', input }, evidence: ['e1', { text: 'e2', confidence: 7 }], confidence: 0.9 }) });
  registry.registerTool({ name: 'Echo', description: 'external echo', cost: 3, tags: ['x'], run: async (ctx, input) => ({ echoed: input }) });
  registry.registerTool({ name: 'boom', run: () => { throw Object.assign(new Error('kaboom'), { code: 'BOOM' }); } });
  registry.registerTool({ name: 'shell', kind: 'external', order: -1, run: () => ({ ok: true }) });
  registerReceiverOwnedTool(registry, { name: 'owned', run: () => ({ ok: false, error: 'nope' }) });
  registry.registerTool({ name: 'echo', description: 'replaced echo', run: (ctx, input) => ({ ok: true, data: input }) });
  const out = { listed: registry.listTools(), got: registry.getTool(' ECHO '), missing: registry.getTool('nope') };
  const approval = createExternalReviewApproval('operator ok');
  const cases = [
    ['ask', 'what', {}],
    ['echo', { q: 1 }, {}],
    ['echo', { q: 1 }, { approval }],
    ['echo', { q: 1 }, { approval: { approved: true, reason: 'forged' } }],
    ['boom', 'x', {}],
    ['boom', 'x', { approval }],
    ['shell', 'rm -rf /', {}],
    ['shell', 'rm -rf /', { approval }],
    ['owned', 'x', {}],
    ['nope', 'x', {}],
    ['echo', { action: 'force_push', target: 'origin/main' }, {}],
    ['ask', { command: 'curl http://x' }, { action: 'ask' }],
  ];
  out.runs = [];
  for (const [name, input, context] of cases) out.runs.push([name, await registry.runTool(name, input, context)]);
  const errors = [];
  for (const bad of [{ name: '' }, { name: 'x', run: 1 }, { name: 'x', kind: 'weird', run() {} }]) {
    try { registry.registerTool(bad); errors.push(null); } catch (error) { errors.push(error.message); }
  }
  out.errors = errors;
  return out;
}

function normalizers() {
  const values = [undefined, null, 0, -1, 0.4, 3, 'x', '0.7', NaN, ['a', null, { confidence: 2 }], { code: 7, message: 'm' }, new Error('e')];
  return values.map((value) => ({
    confidence: WorkflowAgent.normalizeConfidence(value, 0.3),
    evidence: WorkflowAgent.normalizeEvidence(value),
    error: WorkflowAgent.normalizeError(value, 'FALLBACK', 'fallback'),
    budget: WorkflowAgent.resolveBudget(value),
    budgetNoCeiling: WorkflowAgent.resolveBudget(value, null),
  }));
}

async function endToEndRun() {
  const agent = new WorkflowAgent({ budget: 20, maxSteps: 3 });
  agent.registerTool({ name: 'ask', run: (ctx, input) => ({ ok: true, data: { answer: `answer for ${JSON.stringify(input)}` }, confidence: 0.8 }) });
  agent.registerTool({ name: 'verify', run: () => ({ ok: true, data: { status: 'supported' }, evidence: ['proof'] }) });
  agent.registerTool({ name: 'reason', run: () => { throw new Error('reason offline'); } });
  const plan = agent.plan('verify that water boils?');
  const run = await agent.run('verify that water boils?', { approval: createExternalReviewApproval('ok') });
  const strip = (value) => JSON.parse(JSON.stringify(value, (key, v) => (/(At|Time|timestamp|durationMs|startedAt|finishedAt)$/.test(key) ? '<time>' : v)));
  return { plan: strip(plan), run: strip(run) };
}

const sha256 = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function goldenDigests() {
  return {
    'ToolRegistry matrix': sha256(await registryMatrix()),
    'exported normalizers': sha256(normalizers()),
    'WorkflowAgent plan and run': sha256(await endToEndRun()),
  };
}
// harness:end

// Recorded on main, before the change.
const GOLDEN = {
  'ToolRegistry matrix': '160c6016390980c87ffc8817195119bc6f1e28b624a3b176cab39dfd1cf45b61',
  'exported normalizers': 'e533d02cb111625140646321286386b9ded30365e9636c7abb9b3754732302f7',
  'WorkflowAgent plan and run': '92c30536442839a64ab03c3d5f49ad01de7b58225170d049be4e674bfb2c2db5',
};

describe('workflow tool registry, normalisers and run (unchanged)', () => {
  it('the digests are deterministic', async () => {
    assert.deepEqual(await goldenDigests(), await goldenDigests());
  });

  let actual;
  for (const key of Object.keys(GOLDEN)) {
    it(`${key} is byte-identical to main`, async () => {
      actual ||= await goldenDigests();
      assert.equal(actual[key], GOLDEN[key]);
    });
  }
});

describe('the registry, normalisers and approval token live in lib/ (#2132)', () => {
  it('workflow-agent.js re-exports the same registry and helpers', () => {
    const registry = require('../lib/workflow-tool-registry');
    const values = require('../lib/workflow-values');
    const approval = require('../lib/workflow-review-approval');
    assert.equal(WorkflowAgent.ToolRegistry, registry.ToolRegistry);
    assert.equal(WorkflowAgent.normalizeConfidence, values.normalizeConfidence);
    assert.equal(WorkflowAgent.normalizeEvidence, values.normalizeEvidence);
    assert.equal(WorkflowAgent.normalizeError, values.normalizeError);
    assert.equal(WorkflowAgent.createExternalReviewApproval, approval.createExternalReviewApproval);
  });

  it('an approval minted through workflow-agent is honoured by the moved registry, a look-alike is not', () => {
    const approval = require('../lib/workflow-review-approval');
    assert.equal(approval.isExternalReviewApproved(WorkflowAgent.createExternalReviewApproval('ok')), true);
    assert.equal(approval.isExternalReviewApproved({ approved: true, reason: 'forged' }), false);
  });

  it('workflow-agent.js no longer defines the registry and has left the over-800 band', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'workflow-agent.js'), 'utf8');
    assert.doesNotMatch(source, /class ToolRegistry\b/);
    assert.doesNotMatch(source, /function normalizeToolOutput\b/);
    const row = require('../scripts/architecture-snapshot').snapshot().find((item) => item.file === 'workflow-agent.js');
    assert.ok(row && row.lines <= 800, JSON.stringify(row));
  });
});
