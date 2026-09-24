'use strict';
// #2147: agent runs -- the upserted run row and the lifecycle hooks that turn
// runtime callbacks into run and step events.
const crypto = require('node:crypto');
const { digestText, extractUsage, normalizeInteger, normalizeWorkspaceId, nowMs, projectRun } = require('./helpers');
function createObservabilityRuns({ now, statements, internalMetrics, insertEvent }) {
  function upsertRun(input) {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const runId = String(input.runId || '').trim();
    if (!runId) {
      const error = new Error('runId is required');
      error.code = 'INVALID_RUN_ID';
      throw error;
    }
    const current = internalMetrics.measureDatabase(workspaceId, () => statements.getRun.get(workspaceId, runId));
    const timestamp = nowMs(now);
    const startedAt = normalizeInteger(input.startedAt) ?? current?.started_at ?? timestamp;
    const finishedAt = input.finishedAt === null ? null : (normalizeInteger(input.finishedAt) ?? current?.finished_at ?? null);
    const durationMs = normalizeInteger(input.durationMs) ?? (
      finishedAt === null ? (current?.duration_ms ?? null) : Math.max(0, finishedAt - startedAt)
    );
    const usage = extractUsage(input.usage || input.result || input);
    const costMicros = normalizeInteger(input.costMicros ?? usage.costMicros ?? current?.cost_micros);
    const row = {
      runId,
      workspaceId,
      agentId: String(input.agentId ?? current?.agent_id ?? ''),
      runtime: String(input.runtime ?? current?.runtime ?? 'unknown'),
      goalDigest: input.goalDigest || (input.goal ? digestText(input.goal) : (current?.goal_digest || '')),
      goalLength: normalizeInteger(input.goalLength) ?? (input.goal ? String(input.goal).length : Number(current?.goal_length || 0)),
      objective: String(input.objective ?? current?.objective ?? ''),
      status: String(input.status ?? current?.status ?? 'running'),
      startedAt,
      finishedAt,
      durationMs,
      stepCount: normalizeInteger(input.stepCount) ?? Number(current?.step_count || 0),
      successfulSteps: normalizeInteger(input.successfulSteps) ?? Number(current?.successful_steps || 0),
      blockedSteps: normalizeInteger(input.blockedSteps) ?? Number(current?.blocked_steps || 0),
      errorSteps: normalizeInteger(input.errorSteps) ?? Number(current?.error_steps || 0),
      tokens: usage.tokens ?? (current?.tokens === null || current?.tokens === undefined ? null : Number(current.tokens)),
      inputTokens: usage.inputTokens ?? (current?.input_tokens === null || current?.input_tokens === undefined ? null : Number(current.input_tokens)),
      outputTokens: usage.outputTokens ?? (current?.output_tokens === null || current?.output_tokens === undefined ? null : Number(current.output_tokens)),
      costMicros,
      costKnown: costMicros !== null || Boolean(current?.cost_known),
      errorCode: String(input.errorCode ?? current?.error_code ?? ''),
      createdAt: current?.created_at ?? startedAt,
      updatedAt: timestamp,
    };
    internalMetrics.measureDatabase(workspaceId, () => statements.upsertRun.run(
      row.runId, row.workspaceId, row.agentId, row.runtime, row.goalDigest, row.goalLength,
      row.objective, row.status, row.startedAt, row.finishedAt, row.durationMs, row.stepCount,
      row.successfulSteps, row.blockedSteps, row.errorSteps, row.tokens, row.inputTokens,
      row.outputTokens, row.costMicros, row.costKnown ? 1 : 0, row.errorCode,
      row.createdAt, row.updatedAt,
    ));
    return projectRun({
      run_id: row.runId,
      workspace_id: row.workspaceId,
      agent_id: row.agentId,
      runtime: row.runtime,
      goal_digest: row.goalDigest,
      goal_length: row.goalLength,
      objective: row.objective,
      status: row.status,
      started_at: row.startedAt,
      finished_at: row.finishedAt,
      duration_ms: row.durationMs,
      step_count: row.stepCount,
      successful_steps: row.successfulSteps,
      blocked_steps: row.blockedSteps,
      error_steps: row.errorSteps,
      tokens: row.tokens,
      input_tokens: row.inputTokens,
      output_tokens: row.outputTokens,
      cost_micros: row.costMicros,
      cost_known: row.costKnown ? 1 : 0,
      error_code: row.errorCode,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    });
  }

  function recordRunStart(input) {
    const run = upsertRun({ ...input, status: 'running', startedAt: input.startedAt ?? nowMs(now) });
    insertEvent({ ...input, eventType: 'run_started', status: 'running', runId: run.runId });
    return run;
  }

  function recordRunFinish(input) {
    const run = upsertRun(input);
    const event = insertEvent({ ...input, eventType: 'run_finished', status: run.status, runId: run.runId });
    return { run, event };
  }

  function recordStep(input) {
    return insertEvent({ ...input, eventType: 'step_finished' });
  }

  function recordLifecycle(eventName, data = {}) {
    const state = data.state || data;
    const workspaceId = state.workspaceId || data.workspaceId || 'default';
    const runId = String(state.observabilityRunId || state.runId || state.checkpointId || data.runId || crypto.randomUUID());
    state.observabilityRunId = runId;
    const traceId = String(state.traceId || data.traceId || runId);
    state.traceId = traceId;
    if (eventName === 'beforeAgentRun') {
      return recordRunStart({
        workspaceId,
        runId,
        traceId,
        agentId: state.agentId,
        runtime: data.runtime || state.runtime || 'agent-v3',
        goal: state.goal,
        objective: state.objective,
        startedAt: state.startedAt ? Date.parse(state.startedAt) : nowMs(now),
      });
    }
    if (eventName === 'afterTask') {
      const step = data.step || {};
      return recordStep({
        workspaceId,
        runId,
        traceId: step.traceId || traceId,
        agentId: state.agentId,
        status: step.status,
        tool: step.tool,
        result: step.result || step.output,
        payload: { stepId: step.id || null, action: step.action || null, policyAction: step.policy?.action || null },
      });
    }
    if (eventName === 'afterAgentRun') {
      const steps = Array.isArray(state.steps) ? state.steps : [];
      const usages = steps.map(step => extractUsage(step?.result || step?.output || step));
      const usage = usages.reduce((acc, item) => ({
        tokens: acc.tokens === null || item.tokens === null ? null : acc.tokens + item.tokens,
        inputTokens: acc.inputTokens === null || item.inputTokens === null ? null : acc.inputTokens + item.inputTokens,
        outputTokens: acc.outputTokens === null || item.outputTokens === null ? null : acc.outputTokens + item.outputTokens,
        costMicros: acc.costMicros === null || item.costMicros === null ? null : acc.costMicros + item.costMicros,
      }), { tokens: 0, inputTokens: 0, outputTokens: 0, costMicros: 0 });
      const hasUsage = usages.some(item => item.tokens !== null || item.inputTokens !== null || item.outputTokens !== null || item.costMicros !== null);
      const finishedAt = nowMs(now);
      const startedAt = state.startedAt ? Date.parse(state.startedAt) : finishedAt;
      const successfulSteps = steps.filter(step => ['done', 'completed'].includes(String(step.status))).length;
      const blockedSteps = steps.filter(step => String(step.status) === 'blocked').length;
      const errorSteps = steps.filter(step => ['error', 'failed', 'review'].includes(String(step.status))).length;
      const result = recordRunFinish({
        workspaceId,
        runId,
        traceId,
        agentId: state.agentId,
        runtime: data.runtime || state.runtime || 'agent-v3',
        goal: state.goal,
        objective: state.objective,
        status: state.status || (data.ok === false ? 'failed' : 'completed'),
        startedAt: Number.isFinite(startedAt) ? startedAt : finishedAt,
        finishedAt,
        durationMs: Number.isFinite(startedAt) ? Math.max(0, finishedAt - startedAt) : null,
        stepCount: steps.length,
        successfulSteps,
        blockedSteps,
        errorSteps,
        usage: hasUsage ? usage : {},
        errorCode: state.error?.code || state.blockReason || '',
        payload: { resumed: Boolean(state.resumed), remainingSteps: state.remainingSteps ?? null },
      });
      return result;
    }
    return null;
  }

  function recordGateDecision(input) {
    return insertEvent({ ...input, eventType: 'gate_decision', status: input.decision || input.status });
  }
  return { upsertRun, recordRunStart, recordRunFinish, recordStep, recordLifecycle, recordGateDecision };
}
module.exports = { createObservabilityRuns };
