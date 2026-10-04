'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Graph = require('../graph');
const { comparisonInput, budgets } = require('./helpers/cognitive-lab-comparison');
const { computeManifestDigest } = require('../lib/cognitive-lab-manifest');
const { PROBABILITY_OPERATION_PREFIX } = require('../lib/cognitive-lab-probability-calibration');
const { PAIR_OPERATION_PREFIX } = require('../lib/prediction-outcome-pairs');
const {
  prepareComparison, recordComparisonForecast, recordComparisonOutcome,
  recordComparisonBudget, reportComparison,
} = require('../lib/cognitive-lab-comparison-store');

function fixture(t, input = comparisonInput()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-paired-store-'));
  const options = { memoryPath: path.join(dir, 'memory.json'), dbPath: path.join(dir, 'memory.db') };
  let graph = new Graph(options);
  assert.ok(graph._db, 'this acceptance test requires the default native SQLite backend');
  t.after(() => { graph.closeSqlite(); fs.rmSync(dir, { recursive: true, force: true }); });
  return {
    input, get graph() { return graph; },
    reopen() { graph.closeSqlite(); graph = new Graph(options); return graph; },
  };
}

function fill(graph, input) {
  prepareComparison(graph, input);
  for (const task of input.tasks.filter(t => t.split !== 'train')) {
    recordComparisonForecast(graph, { runId: input.runId, variant: 'baseline', taskId: task.taskId, probability: 0.5 });
    recordComparisonForecast(graph, { runId: input.runId, variant: 'candidate', taskId: task.taskId, probability: 0.8 });
    recordComparisonOutcome(graph, { runId: input.runId, taskId: task.taskId, outcome: 'confirmed' });
  }
  for (const [variant, budget] of Object.entries(budgets(input))) {
    recordComparisonBudget(graph, { runId: input.runId, variant, ...budget });
  }
}

test('default SQLite freezes the design, joins one shared outcome and replays after restart', t => {
  const f = fixture(t);
  fill(f.graph, f.input);
  const before = reportComparison(f.graph, { runId: f.input.runId });
  assert.equal(before.status, 'MEASURED');
  assert.equal(before.calibrationComparison, 'MEANINGFUL_IMPROVEMENT');
  assert.equal(before.intelligenceGain, 'NOT_MEASURED');
  assert.equal(before.assertsGain, false);
  assert.ok(Math.abs(before.splits.holdout.delta.brier + 0.21) < 1e-12);
  assert.equal(f.graph.getCommittedMutationResultsByPrefix(PROBABILITY_OPERATION_PREFIX).length, 40);
  assert.equal(f.graph.getCommittedMutationResultsByPrefix(PAIR_OPERATION_PREFIX).filter(r => r.result.outcome).length, 20);
  f.reopen();
  assert.deepEqual(reportComparison(f.graph, { runId: f.input.runId }), before);
  fill(f.graph, f.input);
  assert.deepEqual(reportComparison(f.graph, { runId: f.input.runId }), before);
  assert.equal(f.graph.getCommittedMutationResultsByPrefix(PROBABILITY_OPERATION_PREFIX).length, 40);
});

test('late forecasts, changed replay payloads and changed preregistration fail closed', t => {
  const f = fixture(t);
  prepareComparison(f.graph, f.input);
  const forecast = { runId: f.input.runId, variant: 'baseline', taskId: 'holdout-0', probability: 0.5 };
  recordComparisonForecast(f.graph, forecast);
  assert.throws(() => recordComparisonForecast(f.graph, { ...forecast, probability: 0.9 }), /frozen|differs/);
  recordComparisonOutcome(f.graph, { runId: f.input.runId, taskId: forecast.taskId, outcome: 'confirmed' });
  assert.equal(recordComparisonForecast(f.graph, forecast).replayed, true);
  assert.throws(() => recordComparisonForecast(f.graph, { ...forecast, variant: 'candidate' }), /outcome/);
  assert.throws(() => recordComparisonOutcome(f.graph, { runId: f.input.runId, taskId: forecast.taskId, outcome: 'incident' }), /frozen|differs/);
  const changed = structuredClone(f.input);
  changed.protocol.meaningfulEffect = 0.02;
  changed.experiment.thresholdConfigHash = computeManifestDigest(changed.protocol);
  assert.throws(() => prepareComparison(f.graph, changed), /frozen|differs/);
  assert.equal(f.graph.getCommittedMutationResultsByPrefix(PROBABILITY_OPERATION_PREFIX).length, 1);
});

test('planned missing forecasts and censored results retain the full denominator', t => {
  const f = fixture(t);
  prepareComparison(f.graph, f.input);
  for (const variant of ['baseline', 'candidate']) {
    recordComparisonForecast(f.graph, { runId: f.input.runId, variant, taskId: 'holdout-0', probability: 0.5 });
  }
  recordComparisonOutcome(f.graph, { runId: f.input.runId, taskId: 'holdout-0', outcome: 'censored' });
  recordComparisonOutcome(f.graph, { runId: f.input.runId, taskId: 'holdout-1', outcome: 'confirmed' });
  const result = reportComparison(f.graph, { runId: f.input.runId });
  assert.equal(result.status, 'INSUFFICIENT');
  assert.deepEqual(result.splits.holdout.counts, { attempt: 10, eligible: 1, observed: 0, censored: 1, missing: 9, measurement_error: 0 });
  assert.equal(result.calibrationComparison, 'NOT_MEASURED');
});

test('budget seal is immutable, enforces caps and refuses further new forecasts', t => {
  const f = fixture(t);
  prepareComparison(f.graph, f.input);
  const entry = { runId: f.input.runId, variant: 'baseline', ...budgets(f.input).baseline };
  const oversized = structuredClone(entry);
  oversized.usage.tokens = 1001;
  assert.throws(() => recordComparisonBudget(f.graph, oversized), /budget/);
  const mismatch = structuredClone(entry);
  mismatch.envelope.tokens = 2000;
  assert.throws(() => recordComparisonBudget(f.graph, mismatch), /budget/);
  recordComparisonBudget(f.graph, entry);
  assert.equal(recordComparisonBudget(f.graph, entry).replayed, true);
  assert.throws(() => recordComparisonBudget(f.graph, { ...entry, usage: { ...entry.usage, tokens: 1 } }), /frozen|differs/);
  assert.throws(() => recordComparisonForecast(f.graph, { runId: f.input.runId, variant: 'baseline', taskId: 'holdout-0', probability: 0.5 }), /sealed/);
});

test('caller cannot smuggle confidence, timestamps, train tasks or unknown identities into forecasts', t => {
  const f = fixture(t);
  prepareComparison(f.graph, f.input);
  const entry = { runId: f.input.runId, variant: 'baseline', taskId: 'holdout-0', probability: 0.5 };
  for (const change of [{ confidence: 1 }, { at: '2000-01-01' }, { taskId: 'train' }, { taskId: 'other' }, { variant: 'other' }, { probability: NaN }]) {
    assert.throws(() => recordComparisonForecast(f.graph, { ...entry, ...change }));
  }
  assert.throws(() => reportComparison(f.graph, { runId: 'other' }), /unknown/);
  assert.equal(f.graph.getCommittedMutationResultsByPrefix(PROBABILITY_OPERATION_PREFIX).length, 0);
});

test('failed ledger reads and acknowledged-but-uncommitted writes cannot admit forecasts', t => {
  const f = fixture(t);
  prepareComparison(f.graph, f.input);
  const entry = { runId: f.input.runId, variant: 'baseline', taskId: 'holdout-0', probability: 0.5 };
  const read = f.graph.getCommittedMutationResultsByPrefix.bind(f.graph);
  f.graph.getCommittedMutationResultsByPrefix = prefix => {
    if (prefix === PAIR_OPERATION_PREFIX) throw new Error('injected SQLite read failure');
    return read(prefix);
  };
  assert.throws(() => recordComparisonForecast(f.graph, entry), /injected SQLite read failure/);
  f.graph.getCommittedMutationResultsByPrefix = read;
  const mutate = f.graph.runMutationOnce.bind(f.graph);
  f.graph.runMutationOnce = (id, callback) => id.startsWith(PROBABILITY_OPERATION_PREFIX) ? { result: callback(), replayed: false } : mutate(id, callback);
  assert.throws(() => recordComparisonForecast(f.graph, entry), /not committed/);
  assert.equal(read(PROBABILITY_OPERATION_PREFIX).length, 0);
});

test('run and variant namespaces cannot alias across delimiters', t => {
  const f = fixture(t);
  fill(f.graph, f.input);
  const first = reportComparison(f.graph, { runId: f.input.runId });
  const other = comparisonInput({ runId: `${f.input.runId}:candidate` });
  prepareComparison(f.graph, other);
  recordComparisonForecast(f.graph, { runId: other.runId, variant: 'baseline', taskId: 'holdout-0', probability: 0.1 });
  assert.deepEqual(reportComparison(f.graph, { runId: f.input.runId }), first);
  assert.equal(reportComparison(f.graph, { runId: other.runId }).splits.holdout.counts.observed, 0);
});
