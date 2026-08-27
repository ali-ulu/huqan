'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const Database = require('better-sqlite3');
const huqan = require('../index');
const { createObservabilityService } = require('../lib/observability/service');
const { createAgentV3ObservabilityHooks } = require('../examples/observability-client');
const {
  OBSERVABILITY_CLIENT_ERRORS,
  TELEMETRY_EVENT_TYPES,
  createObservabilityTelemetryClient,
} = require('../lib/observability/client');

function createFixture() {
  const db = new Database(':memory:');
  const service = createObservabilityService({ db, now: () => 2_000 });
  return { db, service };
}

test('telemetry client is a stable root export with a bounded event vocabulary', () => {
  assert.equal(huqan.createObservabilityTelemetryClient, createObservabilityTelemetryClient);
  assert.equal(huqan.ObservabilityTelemetryClient.createObservabilityTelemetryClient, createObservabilityTelemetryClient);
  assert.deepEqual([...TELEMETRY_EVENT_TYPES], [
    'run_started',
    'step_finished',
    'gate_decision',
    'run_finished',
  ]);
  assert.equal(Object.isFrozen(TELEMETRY_EVENT_TYPES), true);
  assert.equal(huqan.OBSERVABILITY_CLIENT_ERRORS.RUN_ID_REQUIRED, OBSERVABILITY_CLIENT_ERRORS.RUN_ID_REQUIRED);
});

test('client records a workspace-scoped AgentV3 lifecycle without persisting plaintext goal or sensitive payload', () => {
  const { db, service } = createFixture();
  try {
    const client = createObservabilityTelemetryClient({
      service,
      workspaceId: 'workspace-a',
      agentId: 'agent-a',
      runtime: 'agent-v3',
    });

    client.startRun({
      runId: 'run-a',
      traceId: 'trace-a',
      goal: 'private goal that must never be persisted',
      startedAt: 1_000,
    });
    client.recordGateDecision({
      runId: 'run-a',
      traceId: 'trace-a',
      decision: 'allow',
      payload: { gate: 'policy', prompt: 'do not persist', secret: 'do not persist' },
    });
    client.recordStep({
      runId: 'run-a',
      traceId: 'trace-a',
      status: 'done',
      tool: 'memory.read',
      usage: { inputTokens: 2, outputTokens: 3 },
      payload: { stepId: 'step-a', phase: 'execute', authorization: 'do not persist' },
    });
    const finished = client.finishRun({
      runId: 'run-a',
      traceId: 'trace-a',
      status: 'completed',
      finishedAt: 1_250,
      stepCount: 1,
      successfulSteps: 1,
      goal: 'private goal that must never be persisted',
    });

    assert.equal(finished.run.workspaceId, 'workspace-a');
    assert.equal(finished.run.runId, 'run-a');
    assert.equal(finished.run.goalDigest, crypto.createHash('sha256')
      .update('private goal that must never be persisted', 'utf8')
      .digest('hex'));
    assert.equal(finished.run.goalLength, 'private goal that must never be persisted'.length);

    const events = service.listEvents({ workspaceId: 'workspace-a', limit: 10 }).items;
    assert.equal(events.length, 4);
    assert.deepEqual(new Set(events.map(event => event.eventType)), new Set([
      'run_started',
      'gate_decision',
      'step_finished',
      'run_finished',
    ]));
    for (const event of events) {
      assert.equal(event.workspaceId, 'workspace-a');
      assert.equal(event.runId, 'run-a');
      assert.equal(event.traceId, 'trace-a');
      assert.equal(JSON.stringify(event), JSON.stringify(event).replaceAll('private goal that must never be persisted', ''));
      assert.equal(Object.prototype.hasOwnProperty.call(event.payload, 'prompt'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(event.payload, 'secret'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(event.payload, 'authorization'), false);
    }
    const storedEventText = db.prepare('SELECT payload_json FROM observability_events').all()
      .map(row => row.payload_json).join('\n');
    assert.equal(storedEventText.includes('do not persist'), false);
  } finally {
    db.close();
  }
});

test('the AgentV3 example maps lifecycle callbacks through the same scoped client', () => {
  const calls = [];
  const service = {
    recordRunStart(input) { calls.push(['start', input]); return input; },
    recordStep(input) { calls.push(['step', input]); return input; },
    recordGateDecision(input) { calls.push(['gate', input]); return input; },
    recordRunFinish(input) { calls.push(['finish', input]); return input; },
  };
  const hooks = createAgentV3ObservabilityHooks({ service, workspaceId: 'workspace-a' });
  hooks.beforeAgentRun({ observabilityRunId: 'run-a', traceId: 'trace-a', goal: 'private goal' });
  hooks.afterTask({
    state: { observabilityRunId: 'run-a', traceId: 'trace-a' },
    step: { id: 'step-a', status: 'done', tool: 'memory.read', output: 'secret output' },
  });
  hooks.afterAgentRun({ observabilityRunId: 'run-a', traceId: 'trace-a', status: 'completed', steps: [{ status: 'done' }] });

  assert.deepEqual(calls.map(([name]) => name), ['start', 'step', 'finish']);
  assert.equal(calls[0][1].workspaceId, 'workspace-a');
  assert.equal(calls[0][1].runId, 'run-a');
  assert.equal(calls[0][1].traceId, 'trace-a');
  assert.equal(Object.prototype.hasOwnProperty.call(calls[0][1], 'goal'), false);
  assert.equal(calls[1][1].payload.stepId, 'step-a');
  assert.equal(Object.prototype.hasOwnProperty.call(calls[1][1].payload, 'output'), false);
  assert.equal(calls[2][1].successfulSteps, 1);
});

test('the AgentV3 example seeds and retains a run/trace identity when the host state is new', () => {
  const calls = [];
  const service = {
    recordRunStart(input) { calls.push(input); return input; },
    recordStep() { return null; },
    recordGateDecision() { return null; },
    recordRunFinish() { return null; },
  };
  const hooks = createAgentV3ObservabilityHooks({ service, workspaceId: 'workspace-a' });
  const state = { goal: 'private goal' };
  hooks.beforeAgentRun(state);

  assert.match(state.observabilityRunId, /^agent-/);
  assert.equal(state.traceId, state.observabilityRunId);
  assert.equal(calls[0].runId, state.observabilityRunId);
  assert.equal(calls[0].traceId, state.traceId);
});

test('client fixes workspace scope and rejects missing identity or plaintext-free goal input violations', () => {
  const { db, service } = createFixture();
  try {
    const client = createObservabilityTelemetryClient({ service, workspaceId: 'workspace-a' });

    assert.throws(
      () => client.recordStep({ workspaceId: 'workspace-b', runId: 'run-a', status: 'done' }),
      error => error.code === OBSERVABILITY_CLIENT_ERRORS.WORKSPACE_SCOPE_MISMATCH,
    );
    assert.throws(
      () => client.recordStep({ runId: 'run-a' }),
      error => error.code === OBSERVABILITY_CLIENT_ERRORS.STATUS_REQUIRED,
    );
    assert.throws(
      () => client.startRun({ traceId: 'trace-a', goal: 'goal' }),
      error => error.code === OBSERVABILITY_CLIENT_ERRORS.RUN_ID_REQUIRED,
    );
    assert.throws(
      () => client.startRun({ runId: 'run-a', goalDigest: 'not-a-digest' }),
      error => error.code === OBSERVABILITY_CLIENT_ERRORS.GOAL_DIGEST_INVALID,
    );
    assert.throws(
      () => createObservabilityTelemetryClient({ service, workspaceId: '' }),
      error => error.code === OBSERVABILITY_CLIENT_ERRORS.WORKSPACE_REQUIRED,
    );
    assert.equal(service.listEvents({ workspaceId: 'workspace-a', limit: 10 }).items.length, 0);
  } finally {
    db.close();
  }
});

test('client forwards no raw goal and preserves service errors instead of failing open', () => {
  const calls = [];
  const failure = new Error('storage unavailable');
  const service = {
    recordRunStart(input) { calls.push({ method: 'start', input }); return { ok: true }; },
    recordStep(input) { calls.push({ method: 'step', input }); throw failure; },
    recordGateDecision(input) { calls.push({ method: 'gate', input }); return { ok: true }; },
    recordRunFinish(input) { calls.push({ method: 'finish', input }); return { ok: true }; },
  };
  const client = createObservabilityTelemetryClient({ service, workspaceId: 'workspace-a' });

  client.startRun({ runId: 'run-a', goal: 'raw goal must stay local' });
  assert.equal(Object.prototype.hasOwnProperty.call(calls[0].input, 'goal'), false);
  assert.equal(typeof calls[0].input.goalDigest, 'string');
  assert.throws(
    () => client.recordStep({ runId: 'run-a', status: 'done', payload: { output: 'raw output' } }),
    error => error === failure,
  );
  assert.equal(Object.prototype.hasOwnProperty.call(calls[1].input.payload, 'output'), false);
});
