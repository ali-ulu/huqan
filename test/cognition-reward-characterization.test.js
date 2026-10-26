'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Graph = require('../graph');
const { OUTCOMES, recordPrediction, recordOutcome, readPredictionPairs } = require('../lib/prediction-outcome-pairs');
const { readValueLedger } = require('../lib/cognition-value-ledger-pairs');
const { expectedFor } = require('../lib/cognition/value-ledger');
const { computeRewardSignal } = require('../lib/cognition/reward-signal');

const AT = '2026-09-10T00:00:00.000Z';
const KEY = 'risk:reward-characterization';
const input = (outcome, expected = null) => ({ source: 'prediction-outcome', key: KEY,
  decisionId: 'scored', outcome, expected, at: AT });

function graphFor(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-m8-characterization-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Graph({ useSQLite: false, memoryPath: path.join(dir, 'memory.json') });
}

// These explicit groups are synthetic reader fixtures, not independent real tasks.
function pair(graph, id, outcome, at = AT, group = id) {
  recordPrediction(graph, { decisionId: id, score: 10, actionClass: 'reward-characterization',
    at, binding: { workspaceId: 'default', runId: `fixture:${id}`, stepId: id,
      frameHash: 'fixture-frame', expectationHash: 'fixture-expectation',
      sourceGroup: group, sourceRefs: [`fixture:${group}`] } });
  if (outcome !== null) recordOutcome(graph, { decisionId: id, outcome, idempotencyKey: id, at });
}

function noWrites(graph) {
  const before = fs.readFileSync(graph.jsonJournalPath(), 'utf8');
  graph.runMutationOnce = () => assert.fail('characterization readers must not write');
  return () => assert.equal(fs.readFileSync(graph.jsonJournalPath(), 'utf8'), before);
}

test('B1 observed, missing, censored and reported classes preserve reward provenance', t => {
  // B1 experiment() classes: test/cognitive-lab-b1-replay.test.js, blob
  // ac52b23756da4068558c70ce5a3d63022a24de87. No B1 modelCalls declaration is used.
  const graph = graphFor(t);
  for (const [id, outcome] of [['h1', 'confirmed'], ['h2', 'confirmed'], ['h3', 'incident'], ['h4', null], ['h5', 'censored']]) {
    pair(graph, id, outcome);
  }
  const unchanged = noWrites(graph);
  const rows = readPredictionPairs(graph);
  const actual = Object.keys(rows).sort().map(id => {
    const result = computeRewardSignal({ ...input(rows[id].outcome?.state ?? null), decisionId: id });
    assert.equal(result.authority, 'SIGNAL_ONLY');
    assert.ok(Object.isFrozen(result));
    return [id, result.status, result.reward, result.rpe, result.expectedSource];
  });
  assert.deepEqual(actual, [
    ['h1', 'MEASURED', 1, 1, 'prior'], ['h2', 'MEASURED', 1, 1, 'prior'],
    ['h3', 'MEASURED', -1, -1, 'prior'], ['h4', 'ABSTAIN', null, null, null],
    ['h5', 'ABSTAIN', null, null, null],
  ]);
  // A B1 reported confirmation is routed as a report, never as observed outcome.
  const reported = computeRewardSignal({ source: 'step-report', key: KEY, decisionId: 'reported-h3',
    status: 'ok', expected: null, at: AT });
  assert.equal(reported.status, 'ABSTAIN');
  assert.equal(reported.reason, 'reported_not_observed');
  assert.equal(reported.rpe, null);
  unchanged();
});

test('every named outcome has its fixed prior reward and RPE sign', () => {
  const oracle = { confirmed: 1, 'reviewer-rejection': -1, rollback: -1,
    compensation: -0.5, contradiction: -1, incident: -1, censored: null };
  assert.deepEqual([...OUTCOMES].sort(), Object.keys(oracle).sort());
  for (const [outcome, reward] of Object.entries(oracle)) {
    const result = computeRewardSignal(input(outcome));
    assert.equal(result.status, reward === null ? 'ABSTAIN' : 'MEASURED');
    assert.equal(result.reward, reward);
    assert.equal(result.rpe, reward);
    if (reward !== null) {
      assert.equal(result.expected, 0);
      assert.equal(Math.sign(result.rpe), Math.sign(reward));
    }
  }
});

test('real journal history supplies nonzero expectations without turning utility into probability', t => {
  const graph = graphFor(t);
  for (let i = 1; i <= 3; i++) pair(graph, `negative-${i}`, 'rollback');
  const unchanged = noWrites(graph);
  const options = { workspaceId: 'default', asOf: '2090-01-01T00:00:00Z',
    historyBoundary: { at: '2090-01-01T00:00:00Z', decisionId: 'scored' } };
  const before = JSON.stringify(options);
  const ledger = readValueLedger(graph, options);
  assert.equal(ledger.status, 'MEASURED');
  assert.equal(ledger.entries[0].nObserved, 3);
  assert.equal(ledger.entries[0].nIndependent, 3);
  const expected = expectedFor(ledger, KEY);
  assert.equal(expected, -1);
  assert.equal(ledger.entries[0].success.p, 0.2);
  for (const [outcome, rpe] of [['confirmed', 2], ['compensation', 0.5], ['rollback', 0]]) {
    const result = computeRewardSignal(input(outcome, expected));
    assert.equal(result.rpe, rpe);
    assert.equal(result.expectedSource, 'value-ledger');
    assert.deepEqual(result, computeRewardSignal(input(outcome, expected)));
  }
  assert.deepEqual(ledger, readValueLedger(graph, options));
  assert.equal(JSON.stringify(options), before);
  assert.equal(expectedFor(ledger, 'unknown-key'), null);
  unchanged();
});

test('the scored outcome, future observations and late backdated commits cannot alter expectation', t => {
  const RealDate = Date;
  let clock = '2030-01-01T00:00:00.000Z';
  t.mock.method(global, 'Date', class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return RealDate.parse(clock); }
  });
  const graph = graphFor(t);
  for (let i = 1; i <= 3; i++) pair(graph, `past-${i}`, 'rollback');
  const options = { workspaceId: 'default', asOf: '2033-01-01T00:00:00Z',
    historyBoundary: { at: '2031-01-01T00:00:00Z', decisionId: 'scored' } };
  const baseline = readValueLedger(graph, options);
  assert.equal(expectedFor(baseline, KEY), -1);
  pair(graph, 'scored', 'confirmed');
  clock = '2032-01-01T00:00:00.000Z';
  pair(graph, 'future', 'confirmed', clock);
  pair(graph, 'late-backdated', 'confirmed', AT);
  const rows = graph.getCommittedMutationResultsByPrefix('prediction-outcome:');
  const lateRows = rows.filter(row => ['future', 'late-backdated'].includes(row.result.decisionId));
  assert.equal(lateRows.length, 4);
  assert.equal(rows.filter(row => row.result.decisionId === 'scored').length, 2);
  assert.ok(lateRows.every(row => RealDate.parse(row.committedAt) > RealDate.parse(options.historyBoundary.at)));
  const unchanged = noWrites(graph);
  const after = readValueLedger(graph, options);
  assert.deepEqual(after, baseline);
  assert.equal(computeRewardSignal(input('compensation', expectedFor(after, KEY))).rpe, 0.5);
  unchanged();
});

test('insufficient or shared-source history uses an explicitly labeled prior', t => {
  const graph = graphFor(t);
  for (let i = 1; i <= 3; i++) pair(graph, `shared-${i}`, 'confirmed', AT, 'one-source');
  const unchanged = noWrites(graph);
  const ledger = readValueLedger(graph, { workspaceId: 'default', asOf: '2090-01-01T00:00:00Z',
    historyBoundary: { at: '2090-01-01T00:00:00Z', decisionId: 'scored' } });
  assert.equal(ledger.status, 'INSUFFICIENT');
  assert.equal(ledger.entries[0].nIndependent, 1);
  assert.equal(ledger.entries[0].value, null);
  const expected = expectedFor(ledger, KEY);
  assert.equal(expected, null);
  const result = computeRewardSignal(input('compensation', expected));
  assert.equal(result.expectedSource, 'prior');
  assert.equal(result.expected, 0);
  assert.equal(result.rpe, -0.5);
  unchanged();
});
