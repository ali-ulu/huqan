'use strict';

// V1 and V3 share lib/agent-step-progression.js for queueing a follow-up step
// but each reports its own rationale wording in the run result. Nothing else
// pins that wording, so a mix-up between the two loops would pass every
// behavioural test while changing what a run reports.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { isolatedKernelOptions } = require('./helpers/isolated-persistence');
const KernelV2 = require('../kernel.v2');
const Agent = require('../agent');
const AgentV3 = require('../agent.v3');

const V1_FOLLOW_UP = 'The result of the previous step required an additional step.';
const V3_FOLLOW_UP = 'Previous step produced a follow-up need.';
const GOAL = 'kedi hayvandir mi?';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-follow-up-rationale-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const kernel = new KernelV2(isolatedKernelOptions('agent', { noLoad: true, useSQLite: false, loadPlugins: false }));
  return { dir, kernel };
}

function rationales(result) {
  const state = result.data || result.state || {};
  return (state.steps || []).map(step => step.rationale);
}

test('V1 reports its own follow-up rationale', (t) => {
  const { dir, kernel } = setup(t);
  const agent = new Agent({ kernel, memoryPath: path.join(dir, 'v1.memory.json') });
  const seen = rationales(agent.run(GOAL));
  assert.ok(seen.includes(V1_FOLLOW_UP), JSON.stringify(seen));
  assert.ok(!seen.includes(V3_FOLLOW_UP), JSON.stringify(seen));
});

test('V3 reports its own follow-up rationale', async (t) => {
  const { dir, kernel } = setup(t);
  const agent = new AgentV3({ kernel, memoryPath: path.join(dir, 'v3.memory.json') });
  const seen = rationales(await agent.run(GOAL, { dreamExperimentLoop: false }));
  assert.ok(seen.includes(V3_FOLLOW_UP), JSON.stringify(seen));
  assert.ok(!seen.includes(V1_FOLLOW_UP), JSON.stringify(seen));
});
