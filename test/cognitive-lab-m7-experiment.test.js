'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runM7Pilot, runM7Child } = require('../lib/cognitive-lab-m7-experiment');

test('controlled M7 pilot isolates urgency and measures real native Coder artifacts', () => {
  const result = runM7Pilot();
  assert.equal(result.assertsGain, false);
  assert.equal(result.status, 'PILOT_ONLY');
  const { control, candidate } = result.arms;
  assert.deepEqual(control.schedulerInputs[0].before, candidate.schedulerInputs[0].before);
  assert.deepEqual(control.schedulerInputs[0].exceptUrgency, candidate.schedulerInputs[0].exceptUrgency);
  assert.ok(control.schedulerInputs[0].used.queued.every(step => step.urgency === 0));
  assert.ok(candidate.schedulerInputs[0].used.queued.some(step => step.urgency > 0));
  assert.equal(control.oracle.ok, false);
  assert.equal(candidate.oracle.ok, true);
  assert.equal(candidate.changed, true);
  assert.equal(control.changed, false);
  assert.notEqual(control.workspaceId, candidate.workspaceId);
  assert.notEqual(control.root, candidate.root);
  assert.deepEqual(control.sources, candidate.sources);
  assert.ok(Object.values(candidate.pairs).some(pair => pair.outcome?.state === 'confirmed'));
  assert.ok(candidate.value.entries.some(entry => entry.nObserved > 0));
  for (const arm of Object.values(result.arms)) {
    assert.equal(arm.cost.modelCalls, 0);
    assert.equal(arm.cost.networkAttempts, 0);
    assert.ok(Object.values(arm.scopeBindings).every(Boolean));
    assert.ok(arm.cost.executorEntries > 0);
    assert.ok(arm.cost.elapsedMs > 0);
    assert.ok(arm.cost.maxRssBytes > 0);
    assert.deepEqual(arm.reopened.pairs, arm.pairs);
    assert.deepEqual(arm.reopened.value, arm.value);
    assert.equal(arm.reopened.journalUnchanged, true);
    assert.equal(arm.reopened.modelCalls, 0);
    assert.equal(arm.reopened.networkAttempts, 0);
    assert.equal(arm.otherWorkspacePairs, 0);
  }
});

for (const scenario of ['denied', 'rollback']) test(`${scenario} preserves gates and original bytes in both arms`, () => {
  const result = runM7Pilot({ scenario });
  for (const arm of Object.values(result.arms)) {
    assert.equal(arm.oracle.ok, false);
    assert.equal(arm.changed, false);
    assert.ok(arm.reports.some(report => report.tool === 'coder'));
    if (scenario === 'denied') {
      assert.equal(arm.approvalStatus, 'pending');
      assert.equal(arm.cost.nativeTestCalls, 0);
      assert.ok(arm.reports.some(report => report.status === 'blocked'));
    } else {
      assert.equal(arm.approvalStatus, 'approved');
      assert.equal(arm.executionOutcome, 'failed');
      assert.equal(arm.consumed, true);
      assert.equal(arm.approvalReplay.refused, true);
      assert.equal(arm.approvalReplay.replayExecutions, 0);
      assert.ok(arm.rollbackVerified);
      assert.ok(arm.cost.nativeTestCalls > 0);
    }
  }
});

test('the model guard observes and refuses an attempted model invocation', () => {
  const result = runM7Child({ mode: 'guard-probe' });
  assert.equal(result.blocked, true);
  assert.equal(result.modelCalls, 1);
});
