const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const metricCollector = require('./metric-collector');
const { ensureMetricsState, recordDecision } = metricCollector._test;

function fakeKernel() {
  return {};
}

test('metric-collector: recordDecision tallies by source and decision', () => {
  const kernel = fakeKernel();
  const state = ensureMetricsState(kernel);
  recordDecision(state, { source: 'mcp-tool-call', decision: 'block' });
  recordDecision(state, { source: 'mcp-tool-call', decision: 'allow' });
  recordDecision(state, { source: 'memory-admission', decision: 'allow' });

  assert.equal(state.total, 3);
  assert.equal(state.bySource['mcp-tool-call'], 2);
  assert.equal(state.bySource['memory-admission'], 1);
  assert.equal(state.byDecision.block, 1);
  assert.equal(state.byDecision.allow, 2);
});

test('metric-collector: recordDecision falls back to "unknown" for a malformed event', () => {
  const kernel = fakeKernel();
  const state = ensureMetricsState(kernel);
  recordDecision(state, {});
  assert.equal(state.bySource.unknown, 1);
  assert.equal(state.byDecision.unknown, 1);
});

test('metric-collector: afterGateDecision hook records into kernel state', () => {
  const kernel = fakeKernel();
  metricCollector.afterGateDecision(kernel, { source: 'agent-loop-budget', decision: 'review' });
  assert.equal(kernel._gateMetricsState.total, 1);
  assert.equal(kernel._gateMetricsState.bySource['agent-loop-budget'], 1);
});

test('metric-collector: run() summary returns an isolated copy, not a live reference', () => {
  const kernel = fakeKernel();
  metricCollector.afterGateDecision(kernel, { source: 'mcp-tool-call', decision: 'allow' });
  const result = metricCollector.run(kernel, { action: 'summary' });
  assert.equal(result.ok, true);
  assert.equal(result.metrics.total, 1);

  result.metrics.bySource['mcp-tool-call'] = 999;
  const secondResult = metricCollector.run(kernel, { action: 'summary' });
  assert.equal(secondResult.metrics.bySource['mcp-tool-call'], 1, 'mutating a returned summary must not affect internal state');
});

test('metric-collector: run() export writes a JSON file and returns its path', () => {
  const kernel = fakeKernel();
  metricCollector.afterGateDecision(kernel, { source: 'mcp-tool-call', decision: 'block' });

  // outputPath must resolve inside the repo root (lib/path-safety) -- a
  // temp dir under the OS temp root would be legitimately rejected, so this
  // uses a throwaway path under benchmarks/ itself and cleans it up.
  const outputPath = path.join(__dirname, '..', 'benchmarks', `tmp-metric-export-test-${process.pid}.json`);
  try {
    const result = metricCollector.run(kernel, { action: 'export', outputPath });
    assert.equal(result.ok, true);
    assert.equal(path.resolve(result.outputPath), path.resolve(outputPath));
    const written = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.equal(written.total, 1);
    assert.equal(written.bySource['mcp-tool-call'], 1);
  } finally {
    fs.rmSync(outputPath, { force: true });
  }
});

test('metric-collector: run() export rejects a path outside the repo root', () => {
  const kernel = fakeKernel();
  metricCollector.afterGateDecision(kernel, { source: 'mcp-tool-call', decision: 'block' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-metric-export-outside-'));
  try {
    const result = metricCollector.run(kernel, { action: 'export', outputPath: path.join(dir, 'telemetry.json') });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'PATH_OUTSIDE_ALLOWED_ROOT');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('metric-collector: run() export defaults to benchmarks/gate-telemetry.json', () => {
  assert.ok(metricCollector._test.DEFAULT_OUTPUT_PATH.endsWith(path.join('benchmarks', 'gate-telemetry.json')));
});

test('metric-collector: run() rejects an unsupported action', () => {
  const kernel = fakeKernel();
  const result = metricCollector.run(kernel, { action: 'nonsense' });
  assert.equal(result.ok, false);
});
