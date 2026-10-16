'use strict';

const crypto = require('node:crypto');

const TERMINAL_RUN_STATUSES = new Set(['completed', 'blocked', 'partial', 'failed', 'paused']);

function validClaimedJob(job) {
  return Boolean(
    job
    && typeof job.jobId === 'string' && job.jobId.length > 0
    && typeof job.workspaceId === 'string' && job.workspaceId.length > 0
    && typeof job.goal === 'string' && job.goal.trim().length > 0 && job.goal.length <= 4000
    && Number.isInteger(job.maxSteps) && job.maxSteps >= 1 && job.maxSteps <= 8
  );
}

function createAgentWorker({ service, createAgent, intervalMs = 1000, leaseMs = 120000, workerId = `agent-worker-${crypto.randomUUID()}` } = {}) {
  if (!service || typeof service.claimNextJob !== 'function' || typeof service.finishJob !== 'function' || typeof service.retryJob !== 'function') {
    throw new TypeError('queue service is required');
  }
  if (typeof createAgent !== 'function') throw new TypeError('createAgent is required');
  let timer = null;
  let busy = false;

  async function tick() {
    if (busy) return null;
    busy = true;
    let job = null;
    let agent = null;
    try {
      job = service.claimNextJob({ workerId, leaseMs });
      if (!job) return null;
      if (!validClaimedJob(job)) {
        return service.finishJob({
          jobId: String(job.jobId || ''), workspaceId: String(job.workspaceId || ''), workerId,
          status: 'failed', errorCode: 'QUEUE_PAYLOAD_INVALID', result: { status: 'failed' },
        });
      }
      agent = createAgent({ workspaceId: job.workspaceId, agentId: job.agentId || workerId });
      if (!agent || typeof agent.run !== 'function') throw new Error('Agent runtime is unavailable.');
      const result = await agent.run(job.goal, {
        workspaceId: job.workspaceId,
        maxSteps: job.maxSteps,
        resume: false,
        agentId: job.agentId || workerId,
      });
      const state = result?.data || result || {};
      const runStatus = String(state.status || (result?.ok ? 'completed' : 'failed')).toLowerCase();
      const status = TERMINAL_RUN_STATUSES.has(runStatus) ? runStatus : 'failed';
      return service.finishJob({
        jobId: job.jobId,
        workspaceId: job.workspaceId,
        workerId,
        status: status === 'completed' ? 'completed' : 'failed',
        runId: state.observabilityRunId || state.runId || state.checkpointId || '',
        errorCode: result?.error?.code || state.error?.code || (status === 'completed' ? '' : 'AGENT_RUN_FAILED'),
        result: { status },
      });
    } catch (error) {
      if (!job) return null;
      return service.retryJob({
        jobId: job.jobId,
        workspaceId: job.workspaceId,
        workerId,
        errorCode: error?.code || 'WORKER_EXECUTION_FAILED',
      });
    } finally {
      try { agent?.storage?.close?.(); } catch (_) {}
      busy = false;
    }
  }

  function start() {
    if (timer) return false;
    timer = setInterval(() => { void tick(); }, Math.max(100, Number(intervalMs) || 1000));
    timer.unref?.();
    return true;
  }

  function stop() {
    if (!timer) return false;
    clearInterval(timer);
    timer = null;
    return true;
  }

  return {
    get busy() { return busy; },
    get workerId() { return workerId; },
    start,
    stop,
    tick,
  };
}

module.exports = { createAgentWorker, TERMINAL_RUN_STATUSES };
