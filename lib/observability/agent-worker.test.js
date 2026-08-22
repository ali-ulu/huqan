'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentWorker } = require('./agent-worker');

test('agent worker claims a job, runs it, completes it, and closes storage', async () => {
  const calls = [];
  const service = {
    claimNextJob: () => ({ jobId: 'job-1', workspaceId: 'ws', goal: 'goal', maxSteps: 2, agentId: 'agent-1' }),
    finishJob: input => { calls.push({ kind: 'finish', input }); return { status: 'completed' }; },
    retryJob: () => { throw new Error('retry should not be called'); },
  };
  let closed = 0;
  const worker = createAgentWorker({
    service,
    createAgent: () => ({
      run: async (goal, options) => {
        calls.push({ kind: 'run', goal, options });
        return { ok: true, data: { status: 'completed', observabilityRunId: 'run-1' } };
      },
      storage: { close: () => { closed += 1; } },
    }),
  });
  await worker.tick();
  assert.equal(calls[0].kind, 'run');
  assert.equal(calls[0].options.workspaceId, 'ws');
  assert.equal(calls[1].input.runId, 'run-1');
  assert.equal(closed, 1);
});

test('agent worker retries infrastructure failures and never approves or bypasses a run', async () => {
  const calls = [];
  const service = {
    claimNextJob: () => ({ jobId: 'job-2', workspaceId: 'ws', goal: 'goal', maxSteps: 2 }),
    finishJob: () => { throw new Error('finish should not be called'); },
    retryJob: input => { calls.push(input); return { status: 'queued' }; },
  };
  const worker = createAgentWorker({ service, createAgent: () => { throw Object.assign(new Error('runtime down'), { code: 'RUNTIME_DOWN' }); } });
  await worker.tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].errorCode, 'RUNTIME_DOWN');
});
