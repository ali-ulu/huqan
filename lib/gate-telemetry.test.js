const test = require('node:test');
const assert = require('node:assert/strict');

const { emitGateTelemetry } = require('./gate-telemetry');

function makeFakeKernel() {
  const emitted = [];
  return {
    emitted,
    plugins: {
      emit(event, data) {
        emitted.push({ event, data });
        return data;
      },
    },
  };
}

test('gate-telemetry: emits afterGateDecision with source, decision, reason, findings', () => {
  const kernel = makeFakeKernel();
  emitGateTelemetry(kernel, 'mcp-tool-call', {
    decision: 'block',
    reason: 'AB2_BLOCKED',
    findings: [{ gate: 'AB2', tool: 'x', decision: 'block' }],
    metadata: { adapterVersion: 'v1' },
  });

  assert.equal(kernel.emitted.length, 1);
  assert.equal(kernel.emitted[0].event, 'afterGateDecision');
  assert.equal(kernel.emitted[0].data.source, 'mcp-tool-call');
  assert.equal(kernel.emitted[0].data.decision, 'block');
  assert.equal(kernel.emitted[0].data.reason, 'AB2_BLOCKED');
  assert.deepEqual(kernel.emitted[0].data.findings, [{ gate: 'AB2', tool: 'x', decision: 'block' }]);
  assert.match(kernel.emitted[0].data.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test('gate-telemetry: silently no-ops when kernel/plugins is missing', () => {
  assert.doesNotThrow(() => emitGateTelemetry(null, 'x', { decision: 'allow' }));
  assert.doesNotThrow(() => emitGateTelemetry({}, 'x', { decision: 'allow' }));
});

test('gate-telemetry: silently no-ops on a missing/malformed decision', () => {
  const kernel = makeFakeKernel();
  emitGateTelemetry(kernel, 'x', null);
  emitGateTelemetry(kernel, 'x', 'not-an-object');
  assert.equal(kernel.emitted.length, 0);
});

test('gate-telemetry: uses plugins.emit (fire-and-forget), never emitStrict', () => {
  const kernel = { plugins: { emit() {}, emitStrict() { throw new Error('must not be called'); } } };
  assert.doesNotThrow(() => emitGateTelemetry(kernel, 'x', { decision: 'allow' }));
});
