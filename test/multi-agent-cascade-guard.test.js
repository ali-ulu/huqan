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
