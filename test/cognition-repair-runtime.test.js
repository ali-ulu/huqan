'use strict';

// COG-B (#4392 PR-3): a declared repair closes one named prior contradiction.
// The closure survives restart through its own journal prefix; a same-family
// success, an unverified repair and a second repair stay withheld.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const Graph = require('../graph');
const { beginStepCognition, observeStepCognition } = require('../lib/agent-cognition-seam');
const { closuresForTarget } = require('../lib/cognition-repair-events');

const frame = { repo: 'fixture', branch: 'main', commit: 'v1', environment: 'test', actor: 'operator',
  time: '2026-10-22T00:00:00Z', goal: 'repair fixture', task: 'repair-v1' };
const digest = (text) => createHash('sha256').update(text).digest('hex');

function environment(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cog-repair-')));
  const memoryPath = path.join(dir, 'graph.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const graph = new Graph({ useSQLite: false, memoryPath });
  const opts = { cognition: { appraisal: true, attribution: true }, cognitionFrame: frame,
    cognitionFileExpectations: {}, cognitionRepairExpectations: {} };
  function expectation(stepId, observedContent, expectedContent = 'expected artifact') {
    const target = path.join(dir, `${stepId}.json`);
    fs.writeFileSync(target, observedContent);
    opts.cognitionFileExpectations[stepId] = { workspaceId: 'default', path: target,
      sourceGroup: stepId, expectedDigest: digest(expectedContent), riskScore: 0 };
  }
  return { dir, memoryPath, graph, opts, expectation };
}

function observe(f, stepId, graph = f.graph) {
  const state = { workspaceId: 'default', observabilityRunId: 'repair-run', goal: frame.goal };
  const step = { id: stepId, tool: 'write', action: 'write' };
  const args = { state, opts: f.opts, graph, step };
  const pending = beginStepCognition(args);
  assert.ok(pending, 'a declared file expectation arms the observation');
  const entry = observeStepCognition({ ...args, report: { status: 'done' } });
  return { entry, pending, state, step, args };
}

test('a specific independently observed repair closes the prior contradiction', t => {
  const f = environment(t);
  f.expectation('fail', 'unexpected artifact');
  const failed = observe(f, 'fail');
  assert.equal(failed.entry.outcome, 'contradiction');

  f.expectation('fix', 'expected artifact');
  f.opts.cognitionRepairExpectations.fix = { targetDecisionId: failed.entry.decisionId };
  const repaired = observe(f, 'fix');
  assert.equal(repaired.entry.repair.status, 'MEASURED');
  assert.equal(repaired.entry.repair.closure, 'CLOSED');
  assert.deepEqual(closuresForTarget(f.graph, failed.entry.decisionId).map((row) => row.repairId),
    [repaired.entry.decisionId]);
});

test('a second repair of the same error stays withheld, also after restart', t => {
  const f = environment(t);
  f.expectation('fail', 'unexpected artifact');
  const failed = observe(f, 'fail');
  f.expectation('fix', 'expected artifact');
  f.opts.cognitionRepairExpectations.fix = { targetDecisionId: failed.entry.decisionId };
  observe(f, 'fix');

  f.expectation('fix2', 'expected artifact');
  f.opts.cognitionRepairExpectations.fix2 = { targetDecisionId: failed.entry.decisionId };
  const second = observe(f, 'fix2');
  assert.equal(second.entry.repair.status, 'ABSTAIN');
  assert.equal(second.entry.repair.closure, 'WITHHELD');
  assert.equal(second.entry.repair.reason, 'already_closed');

  const reopened = new Graph({ useSQLite: false, memoryPath: f.memoryPath });
  assert.equal(closuresForTarget(reopened, failed.entry.decisionId).length, 1);
});

test('a success is not a repair target; an irrelevant link stays withheld', t => {
  const f = environment(t);
  f.expectation('ok', 'expected artifact');
  const success = observe(f, 'ok');
  assert.equal(success.entry.outcome, 'confirmed');

  f.expectation('fix-ok', 'expected artifact');
  f.opts.cognitionRepairExpectations['fix-ok'] = { targetDecisionId: success.entry.decisionId };
  const result = observe(f, 'fix-ok');
  assert.equal(result.entry.repair.status, 'ABSTAIN');
  assert.equal(result.entry.repair.reason, 'source_error_not_observed');
  assert.deepEqual(closuresForTarget(f.graph, success.entry.decisionId), []);
});

test('an unverified repair records no closure', t => {
  const f = environment(t);
  f.expectation('fail', 'unexpected artifact');
  const failed = observe(f, 'fail');
  f.expectation('fix-bad', 'unexpected artifact');
  f.opts.cognitionRepairExpectations['fix-bad'] = { targetDecisionId: failed.entry.decisionId };
  const result = observe(f, 'fix-bad');
  assert.equal(result.entry.repair.closure, 'WITHHELD');
  assert.equal(result.entry.repair.reason, 'repair_not_verified');
  assert.deepEqual(closuresForTarget(f.graph, failed.entry.decisionId), []);
});

test('without a repair declaration the entry carries no repair reading', t => {
  const f = environment(t);
  f.expectation('plain', 'expected artifact');
  const result = observe(f, 'plain');
  assert.equal('repair' in result.entry, false);
  assert.equal(result.entry.attribution.attribution, 'AGENT_CAUSED');
});
