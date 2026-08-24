'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTelemetryClient } = require('./client');

test('package root exports the same telemetry client implementation', () => {
  const root = require('../../index');
  assert.equal(root.createTelemetryClient, createTelemetryClient);
  assert.equal(root.ObservabilityClient.createTelemetryClient, createTelemetryClient);
});

test('telemetry client carries stable workspace run and trace identities', () => {
  const calls = [];
  const client = createTelemetryClient({ sink: { recordLifecycle: (name, data) => calls.push({ name, data }) }, workspaceId: 'ws-a', agentId: 'agent-a', idFactory: () => 'generated' });
  const ids = client.startRun({ metadata: { framework: 'example' } });
  client.finishStep(ids, { status: 'completed', tool: 'search', durationMs: 12, metadata: { attempt: 1 } });
  client.finishRun(ids, { status: 'completed', durationMs: 20 });
  assert.deepEqual(ids, { workspaceId: 'ws-a', runId: 'generated', traceId: 'generated' });
  assert.deepEqual(calls.map(call => call.name), ['run_started', 'step_finished', 'run_finished']);
  assert.equal(calls.every(call => call.data.workspaceId === 'ws-a' && call.data.runId === 'generated' && call.data.traceId === 'generated'), true);
});

test('telemetry client rejects sensitive fields and malformed identifiers before the sink', () => {
  const calls = [];
  const client = createTelemetryClient({ sink: { recordLifecycle: (...args) => calls.push(args) }, workspaceId: 'ws-a' });
  assert.throws(() => client.startRun({ metadata: { nested: { prompt: 'do not send' } } }), { code: 'SENSITIVE_TELEMETRY_FIELD' });
  assert.throws(() => client.finishRun({ runId: 'run-a', traceId: '' }, { status: 'failed' }), /traceId/);
  assert.equal(calls.length, 0);
});
