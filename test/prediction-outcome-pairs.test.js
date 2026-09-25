'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Graph = require('../graph');
const {
  OUTCOMES,
  recordPrediction,
  recordOutcome,
  readPredictionPairs,
} = require('../lib/prediction-outcome-pairs');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-pairs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function memoryGraph(dir) {
  return new Graph({ useSQLite: false, memoryPath: path.join(dir, 'memory.json') });
}

const AT = '2026-01-01T00:00:00.000Z';

test('a prediction pairs with its later outcome, unknown until then', (t) => {
  const graph = memoryGraph(tempDir(t));
  const recorded = recordPrediction(graph, {
    decisionId: 'd1', score: 80, actionClass: 'write', at: AT,
  });
  assert.equal(recorded.replayed, false);
  assert.deepEqual(readPredictionPairs(graph, { decisionId: 'd1' }).d1.outcome, null);
  const outcome = recordOutcome(graph, {
    decisionId: 'd1', outcome: 'reviewer-rejection', idempotencyKey: 'o1', at: AT,
  });
  assert.equal(outcome.replayed, false);
  const pair = readPredictionPairs(graph, { decisionId: 'd1' }).d1;
  assert.equal(pair.prediction.score, 80);
  assert.equal(pair.outcome.state, 'reviewer-rejection');
  assert.deepEqual(OUTCOMES, [
    'reviewer-rejection', 'rollback', 'compensation', 'contradiction',
    'incident', 'confirmed', 'censored',
  ]);
  const replay = recordOutcome(graph, {
    decisionId: 'd1', outcome: 'incident', idempotencyKey: 'o1', at: AT,
  });
  assert.equal(replay.replayed, true);
  assert.equal(readPredictionPairs(graph, { decisionId: 'd1' }).d1.outcome.state, 'reviewer-rejection');
});

test('an unscored prediction requires its unknown reason', (t) => {
  const graph = memoryGraph(tempDir(t));
  recordPrediction(graph, { decisionId: 'd2', score: null, unknown: 'insufficient-data', at: AT });
  assert.equal(readPredictionPairs(graph, { decisionId: 'd2' }).d2.prediction.unknown, 'insufficient-data');
  assert.throws(() => recordPrediction(graph, { decisionId: 'd3', at: AT }), /unknown/);
  assert.throws(() => recordPrediction(graph, { decisionId: 'd3', score: 10, unknown: 'x', at: AT }), /empty/);
});

test('outcomes fail closed on unknown decisions, bad states and second writes', (t) => {
  const graph = memoryGraph(tempDir(t));
  assert.throws(() => recordOutcome(graph, { decisionId: 'ghost', outcome: 'incident', idempotencyKey: 'o' }), /unknown prediction/);
  recordPrediction(graph, { decisionId: 'd4', score: 10, at: AT });
  assert.throws(() => recordOutcome(graph, { decisionId: 'd4', outcome: 'exploded', idempotencyKey: 'o' }), /outcome must be/);
  recordOutcome(graph, { decisionId: 'd4', outcome: 'confirmed', idempotencyKey: 'o1', at: AT });
  assert.throws(() => recordOutcome(graph, { decisionId: 'd4', outcome: 'incident', idempotencyKey: 'o2', at: AT }), /already has an outcome/);
});

test('pairs survive reopening and malformed calls fail closed', (t) => {
  const dir = tempDir(t);
  recordPrediction(memoryGraph(dir), { decisionId: 'd5', score: 55, at: AT });
  const pairs = readPredictionPairs(memoryGraph(dir));
  assert.deepEqual(Object.keys(pairs), ['d5']);
  assert.equal(pairs.d5.outcome, null);

  const graph = memoryGraph(tempDir(t));
  assert.throws(() => recordPrediction(null, { decisionId: 'd', score: 1 }), /graph/);
  assert.throws(() => recordPrediction(graph, { decisionId: 'd', score: 101 }), /between 0 and 100/);
  assert.deepEqual(readPredictionPairs(graph), {});
});
