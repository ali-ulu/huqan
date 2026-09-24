'use strict';
// #2147: the agent job queue -- enqueue, lease-based claim, finish, retry,
// expired-lease recovery -- with a queue event for every transition.
const crypto = require('node:crypto');
const { normalizeInteger, normalizeLimit, normalizeWorkspaceId, nowMs, projectJob, safePayload } = require('./helpers');
const { MAX_ALERT_LIMIT, MAX_METRIC_WINDOW_MS } = require('./service-constants');
function createObservabilityJobs({ db, now, statements, internalMetrics, insertEvent }) {
  function enqueueJob(input = {}) {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const goal = String(input.goal || '').trim();
    if (!goal || goal.length > 4000) {
      const error = new Error('goal is required and must be at most 4000 characters.');
      error.code = 'INVALID_QUEUE_GOAL';
      throw error;
    }
    const maxSteps = Math.min(8, Math.max(1, normalizeInteger(input.maxSteps) ?? 4));
    const maxAttempts = Math.min(5, Math.max(1, normalizeInteger(input.maxAttempts) ?? 3));
    const timestamp = nowMs(now);
    const jobId = String(input.jobId || crypto.randomUUID());
    statements.insertJob.run(
      jobId, workspaceId, String(input.agentId || ''), goal, maxSteps, maxAttempts,
      timestamp, timestamp, timestamp,
    );
    const job = projectJob(statements.getJob.get(workspaceId, jobId));
    insertEvent({ workspaceId, eventType: 'queue_enqueued', status: 'queued', agentId: input.agentId, payload: { jobId, maxSteps } });
    return job;
  }

  function recoverExpiredJobs() {
    const timestamp = nowMs(now);
    const recover = () => {
      const rows = statements.expiredLeases.all(timestamp);
      let recovered = 0;
      for (const row of rows) {
        const terminal = Number(row.attempts || 0) >= Number(row.max_attempts || 0);
        const status = terminal ? 'dead' : 'queued';
        const changed = statements.recoverLease.run(
          status, timestamp, timestamp, row.job_id, row.lease_until,
        ).changes > 0;
        if (!changed) continue;
        recovered += 1;
        insertEvent({
          workspaceId: row.workspace_id,
          eventType: 'queue_finished',
          status,
          runId: row.run_id,
          agentId: row.agent_id,
          payload: { jobId: row.job_id, retry: !terminal, attempt: Number(row.attempts || 0), errorCode: 'WORKER_LEASE_EXPIRED' },
        });
      }
      return recovered;
    };
    return typeof db.transaction === 'function' ? db.transaction(recover)() : recover();
  }

  function claimNextJob({ workerId, leaseMs = 120000 } = {}) {
    const id = String(workerId || '').trim();
    if (!id) throw new TypeError('workerId is required');
    recoverExpiredJobs();
    const claim = () => {
      const row = statements.nextJob.get(nowMs(now));
      if (!row) return null;
      const timestamp = nowMs(now);
      const leaseUntil = timestamp + Math.min(MAX_METRIC_WINDOW_MS, Math.max(1000, normalizeInteger(leaseMs) ?? 120000));
      const result = statements.claimJob.run(leaseUntil, id, timestamp, row.job_id);
      if (!result.changes) return null;
      const claimed = statements.getJob.get(row.workspace_id, row.job_id);
      const job = { ...projectJob(claimed), goal: row.goal };
      insertEvent({ workspaceId: row.workspace_id, eventType: 'queue_started', status: 'running', runId: row.run_id, agentId: row.agent_id, payload: { jobId: row.job_id, attempt: Number(claimed.attempts || 0) } });
      return job;
    };
    return typeof db.transaction === 'function' ? db.transaction(claim)() : claim();
  }

  function finishJob({ jobId, workspaceId, workerId, status, runId = '', errorCode = '', result = null } = {}) {
    const workspace = normalizeWorkspaceId(workspaceId);
    const validStatus = ['completed', 'failed', 'dead'].includes(String(status)) ? String(status) : 'failed';
    const id = String(jobId || '');
    const worker = String(workerId || '');
    if (!statements.getJob.get(workspace, id)) {
      insertEvent({ workspaceId: workspace, eventType: 'queue_finished', status: 'rejected', payload: { jobId: id, errorCode: 'UNKNOWN_QUEUE_JOB' } });
      return null;
    }
    const safeResult = safePayload({ status: result?.status || validStatus, runId: runId || null });
    const changed = statements.completeJob.run(validStatus, String(runId || ''), JSON.stringify(safeResult), String(errorCode || '').slice(0, 160), nowMs(now), id, worker).changes > 0;
    if (!changed) return null;
    const job = projectJob(statements.getJob.get(workspace, id));
    insertEvent({ workspaceId: workspace, eventType: 'queue_finished', status: validStatus, runId, agentId: job?.agentId, payload: { jobId: id, runId: runId || null, errorCode: errorCode || null } });
    return job;
  }

  function retryJob({ jobId, workspaceId, workerId, delayMs = 1000, errorCode = 'WORKER_RETRY' } = {}) {
    const workspace = normalizeWorkspaceId(workspaceId);
    const id = String(jobId || '');
    const worker = String(workerId || '');
    const job = statements.getJob.get(workspace, id);
    if (!job) {
      insertEvent({ workspaceId: workspace, eventType: 'queue_finished', status: 'rejected', payload: { jobId: id, errorCode: 'UNKNOWN_QUEUE_JOB' } });
      return null;
    }
    if (String(job.worker_id || '') !== worker || job.status !== 'running') return null;
    const terminal = Number(job.attempts || 0) >= Number(job.max_attempts || 0);
    const status = terminal ? 'dead' : 'queued';
    const changed = statements.retryJob.run(status, nowMs(now) + Math.max(0, normalizeInteger(delayMs) ?? 1000), String(errorCode || '').slice(0, 160), nowMs(now), id, worker).changes > 0;
    if (!changed) return null;
    const next = projectJob(statements.getJob.get(workspace, id));
    insertEvent({ workspaceId: workspace, eventType: 'queue_finished', status, agentId: next?.agentId, payload: { jobId: id, retry: !terminal, errorCode: errorCode || null } });
    return next;
  }

  function listQueue({ workspaceId, limit } = {}) {
    const workspace = normalizeWorkspaceId(workspaceId);
    return statements.listJobs.all(workspace, normalizeLimit(limit, 50, MAX_ALERT_LIMIT)).map(projectJob);
  }

  function queueSummary({ workspaceId } = {}) {
    const workspace = normalizeWorkspaceId(workspaceId);
    const rows = internalMetrics.measureDatabase(workspace, () => db.prepare(`SELECT status, COUNT(*) AS count FROM agent_queue_jobs
      WHERE workspace_id = ? GROUP BY status`).all(workspace));
    const byStatus = Object.fromEntries(rows.map(row => [row.status, Number(row.count)]));
    const oldest = internalMetrics.measureDatabase(workspace, () => db.prepare(`SELECT MIN(created_at) AS created_at FROM agent_queue_jobs
      WHERE workspace_id = ? AND status IN ('queued', 'running')`).get(workspace));
    const oldestActiveAt = oldest?.created_at === null || oldest?.created_at === undefined
      ? null
      : new Date(Number(oldest.created_at)).toISOString();
    return {
      workspaceId: workspace,
      byStatus,
      depth: Number((byStatus.queued || 0) + (byStatus.running || 0)),
      oldestActiveAt,
      lagMs: oldestActiveAt === null ? 0 : Math.max(0, nowMs(now) - Number(oldest.created_at)),
    };
  }
  return { enqueueJob, recoverExpiredJobs, claimNextJob, finishJob, retryJob, listQueue, queueSummary };
}
module.exports = { createObservabilityJobs };
