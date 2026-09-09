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

  // Repo-contained explicit targets stay bounded to benchmarks/ while
  // tmp/cwd/user-data targets are accepted (H-09); this uses a throwaway
  // path under benchmarks/ itself and cleans it up.
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

test('metric-collector: run() export accepts a path under the OS temp root (H-09, #1982)', () => {
  const kernel = fakeKernel();
  metricCollector.afterGateDecision(kernel, { source: 'mcp-tool-call', decision: 'block' });
  // A read-only install cannot be written to, so tmp/cwd/user-data targets
  // must be accepted -- previously any path outside the repo was rejected
  // with PATH_OUTSIDE_ALLOWED_ROOT, which made exports impossible there.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-metric-export-outside-'));
  try {
    const outputPath = path.join(dir, 'telemetry.json');
    const result = metricCollector.run(kernel, { action: 'export', outputPath });
    assert.equal(result.ok, true);
    assert.equal(path.resolve(result.outputPath), path.resolve(outputPath));
    assert.equal(JSON.parse(fs.readFileSync(outputPath, 'utf8')).total, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('metric-collector: run() export rejects a repo-root-but-outside-benchmarks/ target (#1280)', () => {
  const kernel = fakeKernel();
  metricCollector.afterGateDecision(kernel, { source: 'mcp-tool-call', decision: 'block' });

  // Previously only bounded to REPO_ROOT, so any .json file anywhere in the
  // repo (package.json here) resolved as a valid export target and would
  // have been silently overwritten by writeFileSync.
  const outputPath = path.join(__dirname, '..', 'package.json');
  const result = metricCollector.run(kernel, { action: 'export', outputPath });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PATH_OUTSIDE_ALLOWED_ROOT');
});

test('metric-collector: run() export defaults to a user-data gate-telemetry.json outside the repo (H-09, #1982)', () => {
  const repoRoot = path.join(__dirname, '..');
  const def = metricCollector._test.DEFAULT_OUTPUT_PATH;
  assert.ok(def.endsWith(path.join(path.sep, 'gate-telemetry.json')) || def.endsWith(path.join('gate-telemetry.json')));
  assert.equal(path.relative(repoRoot, path.resolve(def)).startsWith('..'), true,
    'default telemetry path must not live under the install dir');
});

test('metric-collector: run() rejects an unsupported action', () => {
  const kernel = fakeKernel();
  const result = metricCollector.run(kernel, { action: 'nonsense' });
  assert.equal(result.ok, false);
});
