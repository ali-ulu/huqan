'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createObservabilityService } = require('../lib/observability/service');
const { createAgentWorker } = require('../lib/observability/agent-worker');

function durableHarness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-observability-recovery-'));
  const dbPath = path.join(root, 'observability.db');
  let clock = 1_700_000_000_000;
  const open = () => {
    const db = new Database(dbPath);
    return { db, service: createObservabilityService({ db, now: () => clock }) };
  };
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return { dbPath, open, advance(ms) { clock += ms; } };
}

test('server restart preserves event, run and queue state in real SQLite', t => {
  const harness = durableHarness(t);
  const first = harness.open();
  first.service.recordRunStart({ workspaceId: 'ws', runId: 'run-1', goal: 'private goal' });
  first.service.recordStep({ workspaceId: 'ws', runId: 'run-1', status: 'done', tool: 'verify' });
  first.service.enqueueJob({ workspaceId: 'ws', jobId: 'job-1', goal: 'private queue input' });
  first.db.close();

  const second = harness.open();
  try {
    assert.equal(second.service.listRuns({ workspaceId: 'ws' }).items[0].runId, 'run-1');
    assert.deepEqual(second.service.listEvents({ workspaceId: 'ws' }).items.map(item => item.eventType).sort(),
      ['queue_enqueued', 'run_started', 'step_finished']);
    const queue = second.service.listQueue({ workspaceId: 'ws' });
    assert.equal(queue[0].jobId, 'job-1');
    assert.equal(queue[0].status, 'queued');
    assert.equal(JSON.stringify({ queue, events: second.service.listEvents({ workspaceId: 'ws' }) }).includes('private'), false);
  } finally { second.db.close(); }
});

test('expired crash lease is reclaimed once, bounded, observable, then dead', t => {
  const harness = durableHarness(t);
  const first = harness.open();
  first.service.enqueueJob({ workspaceId: 'ws', jobId: 'job-crash', goal: 'safe fixture', maxAttempts: 2 });
  assert.equal(first.service.claimNextJob({ workerId: 'worker-a', leaseMs: 1000 }).attempts, 1);
  first.db.close();

  harness.advance(1001);
  const second = harness.open();
  assert.equal(second.service.claimNextJob({ workerId: 'worker-b', leaseMs: 1000 }).attempts, 2);
  assert.equal(second.service.claimNextJob({ workerId: 'worker-c', leaseMs: 1000 }), null);
  second.db.close();

  harness.advance(1001);
  const third = harness.open();
  try {
    assert.equal(third.service.recoverExpiredJobs(), 1);
    const job = third.service.listQueue({ workspaceId: 'ws' })[0];
    assert.equal(job.status, 'dead');
    assert.equal(job.attempts, 2);
    assert.equal(job.errorCode, 'WORKER_LEASE_EXPIRED');
    assert.equal(third.service.claimNextJob({ workerId: 'worker-d' }), null);
    const recovery = third.service.listEvents({ workspaceId: 'ws' }).items
      .filter(event => event.payload.errorCode === 'WORKER_LEASE_EXPIRED');
    assert.deepEqual(recovery.map(event => event.status).sort(), ['dead', 'queued']);
  } finally { third.db.close(); }
});

test('two SQLite connections cannot claim the same job', t => {
  const harness = durableHarness(t);
  const left = harness.open();
  const right = harness.open();
  try {
    left.service.enqueueJob({ workspaceId: 'ws', jobId: 'job-atomic', goal: 'safe fixture' });
    const claims = [left.service.claimNextJob({ workerId: 'worker-left' }), right.service.claimNextJob({ workerId: 'worker-right' })];
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(left.service.listQueue({ workspaceId: 'ws' })[0].attempts, 1);
    assert.equal(left.service.listEvents({ workspaceId: 'ws', eventType: 'queue_started' }).items.length, 1);
  } finally { left.db.close(); right.db.close(); }
});

test('worker separates terminal agent failure from retryable infrastructure failure', async t => {
  const harness = durableHarness(t);
  const { db, service } = harness.open();
  try {
    service.enqueueJob({ workspaceId: 'ws', jobId: 'terminal', goal: 'safe fixture' });
    const terminal = createAgentWorker({ service, workerId: 'terminal-worker', createAgent: () => ({
      run: async () => ({ ok: false, data: { status: 'blocked' }, error: { code: 'POLICY_BLOCKED' } }),
    }) });
    await terminal.tick();
    const terminalJob = service.listQueue({ workspaceId: 'ws' }).find(job => job.jobId === 'terminal');
    assert.equal(terminalJob.status, 'failed');
    assert.equal(terminalJob.attempts, 1);

    service.enqueueJob({ workspaceId: 'ws', jobId: 'retryable', goal: 'safe fixture', maxAttempts: 1 });
    const retryable = createAgentWorker({ service, workerId: 'infra-worker', createAgent: () => {
      throw Object.assign(new Error('runtime unavailable'), { code: 'RUNTIME_DOWN' });
    } });
    await retryable.tick();
    const retryJob = service.listQueue({ workspaceId: 'ws' }).find(job => job.jobId === 'retryable');
    assert.equal(retryJob.status, 'dead');
    assert.equal(retryJob.attempts, 1);
    assert.equal(retryJob.errorCode, 'RUNTIME_DOWN');
    const events = service.listEvents({ workspaceId: 'ws', eventType: 'queue_finished' }).items;
    assert.equal(events.some(event => event.status === 'failed' && event.payload.errorCode === 'POLICY_BLOCKED'), true);
    assert.equal(events.some(event => event.status === 'dead' && event.payload.errorCode === 'RUNTIME_DOWN'), true);
  } finally { db.close(); }
});

test('unknown jobs and incompatible schema fail closed', t => {
  const harness = durableHarness(t);
  const { db, service } = harness.open();
  assert.equal(service.finishJob({ jobId: 'missing', workspaceId: 'ws', workerId: 'worker', status: 'completed' }), null);
  assert.equal(service.retryJob({ jobId: 'missing', workspaceId: 'ws', workerId: 'worker' }), null);
  const rejected = service.listEvents({ workspaceId: 'ws', eventType: 'queue_finished' }).items;
  assert.equal(rejected.length, 2);
  assert.equal(rejected.every(event => event.status === 'rejected' && event.payload.errorCode === 'UNKNOWN_QUEUE_JOB'), true);
  db.close();

  const broken = new Database(path.join(path.dirname(harness.dbPath), 'broken.db'));
  broken.exec('CREATE TABLE agent_queue_jobs (job_id TEXT PRIMARY KEY)');
  assert.throws(() => createObservabilityService({ db: broken }), /no column named workspace_id|no such column/);
  assert.deepEqual(broken.prepare('PRAGMA table_info(agent_queue_jobs)').all().map(row => row.name), ['job_id']);
  broken.close();
});
