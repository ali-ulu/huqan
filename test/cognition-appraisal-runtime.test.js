'use strict';

// COG-A (#4391 PR-2): the appraisal reading is derived from a real file-effect
// observation. A confirmed predeclared digest is goal progress; a contradicted
// one is unexpected. Execution is not causation, so regret stays withheld.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const KernelV2 = require('../kernel.v2');
const { beginStepCognition, observeStepCognition } = require('../lib/agent-cognition-seam');

const frame = { repo: 'fixture', branch: 'main', commit: 'v1', environment: 'test', actor: 'host',
  time: '2026-10-22T00:00:00Z', goal: 'appraisal fixture', task: 'appraisal-v1' };
const digest = (text) => createHash('sha256').update(text).digest('hex');

function environment(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cog-appraisal-'));
  const kernel = new KernelV2({ noLoad: true, useSQLite: false, loadPlugins: false,
    memoryPath: path.join(dir, 'graph.json') });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const opts = { cognition: { appraisal: true }, cognitionFrame: frame, cognitionFileExpectations: {} };
  function expectation(stepId, observedContent, expectedContent = 'expected artifact') {
    const target = path.join(dir, `${stepId}.json`);
    fs.writeFileSync(target, observedContent);
    opts.cognitionFileExpectations[stepId] = { workspaceId: 'default', path: target,
      sourceGroup: stepId, expectedDigest: digest(expectedContent), riskScore: 0 };
  }
  return { kernel, opts, expectation };
}

function observe(f, stepId, runId = 'run-1') {
  const state = { workspaceId: 'default', observabilityRunId: runId, goal: frame.goal };
  const step = { id: stepId, tool: 'write', action: 'write' };
  const args = { state, opts: f.opts, graph: f.kernel.graph, step };
  const pending = beginStepCognition(args);
  assert.ok(pending, 'a declared file expectation arms the observation');
  const entry = observeStepCognition({ ...args, report: { status: 'done' } });
  return { entry, pending, state, step, args };
}

test('a confirmed file-effect observation yields satisfaction, signal only', t => {
  const f = environment(t);
  f.expectation('confirmed', 'expected artifact');
  const { entry } = observe(f, 'confirmed');
  assert.equal(entry.outcome, 'confirmed');
  assert.equal(entry.appraisal.status, 'MEASURED');
  assert.equal(entry.appraisal.label, 'satisfaction');
  assert.equal(entry.appraisal.authority, 'SIGNAL_ONLY');
  assert.equal(entry.appraisal.dimensions.goalImpact.value, 1);
  assert.equal(entry.appraisal.dimensions.goalImpact.source, `prediction-outcome:${entry.decisionId}:confirmed`);
  assert.equal(entry.appraisal.withheld.find((row) => row.label === 'regret').reason, 'goal_not_negative');
});

test('a contradicted observation yields surprise, never regret without causal evidence', t => {
  const f = environment(t);
  f.expectation('contradicted', 'unexpected artifact');
  const { entry } = observe(f, 'contradicted');
  assert.equal(entry.outcome, 'contradiction');
  assert.equal(entry.appraisal.status, 'MEASURED');
  assert.deepEqual(entry.appraisal.labels.map((row) => row.label), ['surprise']);
  assert.equal(entry.appraisal.dimensions.goalImpact.value, -1);
  assert.equal(entry.appraisal.dimensions.unexpectedness.value, 1);
  assert.equal(entry.appraisal.withheld.find((row) => row.label === 'regret').reason, 'responsibility_unknown');
});

test('without a declared observation the appraisal abstains instead of inventing one', t => {
  const f = environment(t);
  const state = { workspaceId: 'default', observabilityRunId: 'run-missing', goal: frame.goal };
  const step = { id: 'missing', tool: 'write', action: 'write' };
  const args = { state, opts: f.opts, graph: f.kernel.graph, step };
  assert.equal(beginStepCognition(args), null);
  const entry = observeStepCognition({ ...args, report: { status: 'done' } });
  assert.equal(entry.status, 'ABSTAIN');
  assert.equal(entry.appraisal.status, 'ABSTAIN');
  assert.equal(entry.appraisal.reason, 'bound_observation_unavailable');
});

test('with the flag off the observation entry carries no appraisal', t => {
  const f = environment(t);
  f.expectation('reward-only', 'expected artifact');
  f.opts.cognition = { predictionError: true, reward: true };
  const { entry } = observe(f, 'reward-only');
  assert.equal(entry.outcome, 'confirmed');
  assert.equal('appraisal' in entry, false);
});

test('a replayed decision keeps the same appraisal reading', t => {
  const f = environment(t);
  f.expectation('replay', 'unexpected artifact');
  const first = observe(f, 'replay');
  first.state.cognition.pending = first.pending;
  const replay = observeStepCognition({ ...first.args, report: { status: 'done' } });
  assert.equal(replay.replayed, true);
  assert.equal(replay.appraisal.status, first.entry.appraisal.status);
  assert.deepEqual(replay.appraisal.labels, first.entry.appraisal.labels);
});
