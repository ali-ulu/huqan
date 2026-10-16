'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMultiAgentCascadeGuard, REASONS } = require('../lib/multi-agent-cascade-guard');

test('rejects plans that exceed the configured root or descendant fan-out', async () => {
  const guard = createMultiAgentCascadeGuard({ maxFanOut: 1 });
  const result = await guard.run([
    { id: 'root-a', agentId: 'a' },
    { id: 'root-b', agentId: 'b' },
  ], async () => ({ ok: true }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, REASONS.INVALID_PLAN);
  assert.match(result.error, /root fan-out/);
});

test('isolates a failed dependency while independent agents continue', async () => {
  const guard = createMultiAgentCascadeGuard();
  const calls = [];
  const result = await guard.run([
    { id: 'broken', agentId: 'a' },
    { id: 'dependent', agentId: 'b', dependsOn: ['broken'] },
    { id: 'independent', agentId: 'c' },
  ], async (task) => {
    calls.push(task.id);
    return task.id === 'broken' ? { ok: false, error: { code: 'UPSTREAM_DOWN' } } : { ok: true };
  });
  assert.deepEqual(calls, ['broken', 'independent']);
  assert.deepEqual(result.summary, { completed: 1, failed: 1, blocked: 1 });
  assert.deepEqual(result.tasks.find((entry) => entry.id === 'dependent'), {
    id: 'dependent', agentId: 'b', status: 'blocked', reason: REASONS.DEPENDENCY_FAILED, dependency: 'broken', attempts: 0,
  });
});

test('limits retryable execution failures and opens an agent-local circuit', async () => {
  let clock = 1000;
  const guard = createMultiAgentCascadeGuard({ failureThreshold: 1, maxRetries: 2, cooldownMs: 5000, now: () => clock });
  let calls = 0;
  const fail = async () => {
    calls += 1;
    return { ok: false, error: { code: 'TEMPORARY', retryable: true } };
  };
  const first = await guard.run([{ id: 'first', agentId: 'same-agent' }], fail);
  assert.equal(calls, 3);
  assert.equal(first.tasks[0].status, 'failed');
  const blocked = await guard.run([{ id: 'second', agentId: 'same-agent' }], fail);
  assert.equal(calls, 3, 'the open circuit must not call the failed agent again');
  assert.equal(blocked.tasks[0].reason, REASONS.CIRCUIT_OPEN);
  clock += 5000;
  await guard.run([{ id: 'other', agentId: 'different-agent' }], async () => ({ ok: true }));
  assert.equal(calls, 3, 'one agent circuit must not block another agent');
});

test('rejects unknown dependencies before any agent is executed', async () => {
  const guard = createMultiAgentCascadeGuard();
  let calls = 0;
  const result = await guard.run([{ id: 'child', agentId: 'a', dependsOn: ['missing'] }], async () => {
    calls += 1;
    return { ok: true };
  });
  assert.equal(calls, 0);
  assert.equal(result.reason, REASONS.INVALID_PLAN);
  assert.match(result.error, /unknown task/);
});

test('rejects dependency cycles before any agent is executed', async () => {
  const guard = createMultiAgentCascadeGuard({ maxFanOut: 2 });
  let calls = 0;
  const result = await guard.run([
    { id: 'a', agentId: 'agent-a', dependsOn: ['b'] },
    { id: 'b', agentId: 'agent-b', dependsOn: ['a'] },
  ], async () => {
    calls += 1;
    return { ok: true };
  });
  assert.equal(calls, 0);
  assert.equal(result.reason, REASONS.INVALID_PLAN);
  assert.match(result.error, /dependency cycle/);
});

// validatePlan is exported for plan validation without execution. Its only
// direct caller was the removed DelegationService v0 (#3315), so the plan
// shape rules are pinned here against the guard itself.
test('validatePlan accepts a well-formed DAG and snapshots each task', () => {
  const { validatePlan } = require('../lib/multi-agent-cascade-guard');
  const input = [
    { id: ' a ', agentId: 'agent-1', input: { q: 1 } },
    { id: 'b', agentId: 'agent-2', dependsOn: ['a'] },
    { id: 'c', agentId: 'agent-2', dependsOn: ['a', 'b'] },
  ];
  const { plan, byId } = validatePlan(input, 2);
  assert.deepEqual(plan.map((task) => task.id), ['a', 'b', 'c']);
  assert.deepEqual(byId.get('c').dependsOn, ['a', 'b']);
  assert.deepEqual(plan[0].dependsOn, [], 'a missing dependsOn is an empty list');
  assert.equal(Object.isFrozen(plan[2]), true);
  assert.equal(Object.isFrozen(plan[2].dependsOn), true);
});

test('validatePlan rejects every malformed plan shape with a specific reason', () => {
  const { validatePlan } = require('../lib/multi-agent-cascade-guard');
  const cases = [
    [[], /non-empty array/],
    ['not an array', /non-empty array/],
    [[null], /each task must be an object/],
    [[['x']], /each task must be an object/],
    [[{ id: '', agentId: 'a' }], /task\.id must be a non-empty string/],
    [[{ id: 'a', agentId: '  ' }], /task\.agentId must be a non-empty string/],
    [[{ id: 'a', agentId: 'x', dependsOn: 'b' }], /task\.dependsOn must be an array/],
    [[{ id: 'a', agentId: 'x', dependsOn: [7] }], /task\.dependsOn entry must be a non-empty string/],
    [[{ id: 'b', agentId: 'x' }, { id: 'a', agentId: 'x', dependsOn: ['b', 'b'] }], /task a repeats a dependency/],
    [[{ id: 'a', agentId: 'x', dependsOn: ['a'] }], /task a cannot depend on itself/],
    [[{ id: 'a', agentId: 'x' }, { id: 'a', agentId: 'y' }], /task id a is duplicated/],
    [[{ id: 'a', agentId: 'x', dependsOn: ['ghost'] }], /task a depends on unknown task ghost/],
    [[{ id: 'r1', agentId: 'x' }, { id: 'r2', agentId: 'x' }, { id: 'r3', agentId: 'x' }], /root fan-out exceeds 2/],
    [[{ id: 'r', agentId: 'x' }, ...['c1', 'c2', 'c3'].map((id) => ({ id, agentId: 'x', dependsOn: ['r'] }))], /task r fan-out exceeds 2/],
    [[{ id: 'r', agentId: 'x' }, { id: 'a', agentId: 'x', dependsOn: ['r', 'b'] }, { id: 'b', agentId: 'x', dependsOn: ['a'] }], /task dependency cycle includes/],
  ];
  for (const [tasks, reason] of cases) {
    assert.throws(() => validatePlan(tasks, 2), reason, `expected ${reason} for ${JSON.stringify(tasks)}`);
  }
});
