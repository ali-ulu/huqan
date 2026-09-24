'use strict';

// DelegationService v0 (#2505/E1): validation-only boundary. A delegation
// plan is evaluated, never executed here: existing execution paths are
// untouched in this slice, and the guard's run() is not called.

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { createDelegationService, DEFAULT_MAX_FAN_OUT, DEFAULT_MAX_TASKS, DEFAULT_MAX_DEPTH, DEFAULT_MAX_AGENTS } = require('../lib/delegation-service');

const task = (id, agentId = 'agent-a', dependsOn = []) => ({ id, agentId, dependsOn });

describe('DelegationService v0 plan validation', () => {
  it('accepts a well-formed plan and reports its shape', () => {
    const service = createDelegationService();
    const verdict = service.evaluatePlan([
      task('t1'),
      task('t2', 'agent-b', ['t1']),
    ]);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.reason, 'DELEGATION_PLAN_VALID');
    assert.equal(verdict.taskCount, 2);
    assert.equal(verdict.rootCount, 1);
    assert.equal(verdict.maxFanOut, DEFAULT_MAX_FAN_OUT);
    assert.deepEqual(verdict.tasks, [
      { id: 't1', agentId: 'agent-a', dependsOn: [] },
      { id: 't2', agentId: 'agent-b', dependsOn: ['t1'] },
    ]);
    assert.ok(Object.isFrozen(verdict));
  });

  it('rejects root fan-out above the configured bound without executing anything', () => {
    const service = createDelegationService({ maxFanOut: 1 });
    const verdict = service.evaluatePlan([task('t1'), task('t2')]);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'INVALID_PLAN');
    assert.match(verdict.error, /root fan-out exceeds 1/);
    assert.deepEqual(verdict.tasks, []);
  });

  it('rejects cycles, unknown dependencies, duplicates and self-dependency', () => {
    const service = createDelegationService();
    for (const [label, plan] of [
      ['cycle', [task('t1', 'a', ['t2']), task('t2', 'a', ['t1'])]],
      ['unknown', [task('t1', 'a', ['ghost'])]],
      ['duplicate', [task('t1'), task('t1')]],
      ['self', [task('t1', 'a', ['t1'])]],
      ['empty', []],
      ['missing', null],
    ]) {
      const verdict = service.evaluatePlan(plan);
      assert.equal(verdict.ok, false, label);
      assert.equal(verdict.reason, 'INVALID_PLAN', label);
      assert.ok(verdict.error.length > 0, label);
    }
  });

  it('rejects a malformed service configuration up front', () => {
    for (const options of [null, 4, 'x', { maxFanOut: 0 }, { maxFanOut: 65 }, { maxFanOut: 1.5 }]) {
      assert.throws(() => createDelegationService(options), TypeError);
    }
    for (const options of [
      { maxTasks: 0 }, { maxTasks: 65 }, { maxTasks: 1.5 },
      { maxDepth: 0 }, { maxDepth: 17 }, { maxDepth: 1.5 },
      { maxAgents: 0 }, { maxAgents: 33 }, { maxAgents: 1.5 },
    ]) {
      assert.throws(() => createDelegationService(options), TypeError);
    }
  });

  it('never calls the guard run path: evaluation has no executor', () => {
    const service = createDelegationService();
    assert.equal(typeof service.run, 'undefined');
    assert.equal(typeof service.evaluatePlan, 'function');
  });

  it('reports spawn measurements next to their bounds on a valid plan', () => {
    const service = createDelegationService();
    const verdict = service.evaluatePlan([
      task('t1', 'agent-a'),
      task('t2', 'agent-b', ['t1']),
    ]);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.distinctAgents, 2);
    assert.equal(verdict.depth, 2);
    assert.equal(verdict.maxTasks, DEFAULT_MAX_TASKS);
    assert.equal(verdict.maxDepth, DEFAULT_MAX_DEPTH);
    assert.equal(verdict.maxAgents, DEFAULT_MAX_AGENTS);
  });

  it('rejects a plan whose task count exceeds maxTasks', () => {
    const service = createDelegationService({ maxFanOut: 4, maxTasks: 2 });
    const verdict = service.evaluatePlan([task('t1'), task('t2'), task('t3')]);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'INVALID_PLAN');
    assert.match(verdict.error, /exceeds maxTasks 2/);
    assert.deepEqual(verdict.tasks, []);
  });

  it('rejects a plan whose chain depth exceeds maxDepth', () => {
    const service = createDelegationService({ maxFanOut: 4, maxDepth: 2 });
    const verdict = service.evaluatePlan([
      task('t1'),
      task('t2', 'agent-a', ['t1']),
      task('t3', 'agent-a', ['t2']),
    ]);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'INVALID_PLAN');
    assert.match(verdict.error, /exceeds maxDepth 2/);
    assert.deepEqual(verdict.tasks, []);
  });

  it('rejects a plan with more distinct agents than maxAgents', () => {
    const service = createDelegationService({ maxFanOut: 4, maxAgents: 1 });
    const verdict = service.evaluatePlan([task('t1', 'agent-a'), task('t2', 'agent-b')]);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'INVALID_PLAN');
    assert.match(verdict.error, /exceeds maxAgents 1/);
    assert.deepEqual(verdict.tasks, []);
  });
});
