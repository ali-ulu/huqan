'use strict';

// COG-B (#4392 PR-2): attribution is derived from the bound file-effect
// observation plus the host-declared expectation. Responsibility reaches the
// appraisal only on AGENT_CAUSED; a declared external cause is a CONFLICT.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const KernelV2 = require('../kernel.v2');
const { beginStepCognition, observeStepCognition } = require('../lib/agent-cognition-seam');

const frame = { repo: 'fixture', branch: 'main', commit: 'v1', environment: 'test', actor: 'host',
  time: '2026-10-22T00:00:00Z', goal: 'attribution fixture', task: 'attribution-v1' };
const digest = (text) => createHash('sha256').update(text).digest('hex');

function environment(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cog-attribution-'));
  const kernel = new KernelV2({ noLoad: true, useSQLite: false, loadPlugins: false,
    memoryPath: path.join(dir, 'graph.json') });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const opts = { cognition: { appraisal: true, attribution: true }, cognitionFrame: frame,
    cognitionFileExpectations: {}, cognitionExternalCauses: {} };
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

test('an independent binding attributes a confirmed outcome to the agent', t => {
  const f = environment(t);
  f.expectation('confirmed', 'expected artifact');
  const { entry } = observe(f, 'confirmed');
  assert.equal(entry.outcome, 'confirmed');
  assert.equal(entry.attribution.status, 'MEASURED');
  assert.equal(entry.attribution.attribution, 'AGENT_CAUSED');
  assert.equal(entry.attribution.authority, 'SIGNAL_ONLY');
  assert.equal(entry.appraisal.dimensions.responsibility.value, 1);
  assert.equal(entry.appraisal.dimensions.responsibility.source, entry.attribution.sourceDigest);
});

test('attributed failure reaches the appraisal, but regret still needs an alternative', t => {
  const f = environment(t);
  f.expectation('contradicted', 'unexpected artifact');
  const { entry } = observe(f, 'contradicted');
  assert.equal(entry.outcome, 'contradiction');
  assert.equal(entry.attribution.attribution, 'AGENT_CAUSED');
  assert.deepEqual(entry.appraisal.labels.map((row) => row.label), ['surprise']);
  assert.equal(entry.appraisal.withheld.find((row) => row.label === 'regret').reason, 'alternative_missing');
  assert.equal(entry.appraisal.label, 'surprise');
});

test('a declared external cause makes the reading a conflict, not a blame', t => {
  const f = environment(t);
  f.expectation('external', 'unexpected artifact');
  f.opts.cognitionExternalCauses.external = { kind: 'external-cause', ref: 'external:process', workspaceId: 'default' };
  const { entry } = observe(f, 'external');
  assert.equal(entry.attribution.status, 'MEASURED');
  assert.equal(entry.attribution.attribution, 'CONFLICT');
  assert.equal(entry.appraisal.dimensions.responsibility.status, 'UNKNOWN');
  assert.equal(entry.appraisal.withheld.find((row) => row.label === 'regret').reason, 'responsibility_unknown');
});

test('with the flag off no attribution is attached', t => {
  const f = environment(t);
  f.expectation('appraisal-only', 'expected artifact');
  f.opts.cognition = { appraisal: true };
  const { entry } = observe(f, 'appraisal-only');
  assert.equal('attribution' in entry, false);
  assert.equal(entry.appraisal.status, 'MEASURED');
});

test('attribution alone runs the observation path without an appraisal', t => {
  const f = environment(t);
  f.expectation('attribution-only', 'expected artifact');
  f.opts.cognition = { attribution: true };
  const { entry } = observe(f, 'attribution-only');
  assert.equal(entry.attribution.attribution, 'AGENT_CAUSED');
  assert.equal('appraisal' in entry, false);
});

test('without an observation the attribution abstains instead of blaming', t => {
  const f = environment(t);
  const state = { workspaceId: 'default', observabilityRunId: 'run-missing', goal: frame.goal };
  const step = { id: 'missing', tool: 'write', action: 'write' };
  const args = { state, opts: f.opts, graph: f.kernel.graph, step };
  assert.equal(beginStepCognition(args), null);
  const entry = observeStepCognition({ ...args, report: { status: 'done' } });
  assert.equal(entry.status, 'ABSTAIN');
  assert.equal(entry.attribution.status, 'ABSTAIN');
  assert.equal(entry.attribution.reason, 'bound_observation_unavailable');
  assert.equal(entry.attribution.attribution, 'UNKNOWN');
});

test('a replayed decision keeps the same attribution', t => {
  const f = environment(t);
  f.expectation('replay', 'unexpected artifact');
  const first = observe(f, 'replay');
  first.state.cognition.pending = first.pending;
  const replay = observeStepCognition({ ...first.args, report: { status: 'done' } });
  assert.equal(replay.replayed, true);
  assert.equal(replay.attribution.attribution, first.entry.attribution.attribution);
  assert.equal(replay.attribution.status, first.entry.attribution.status);
});
