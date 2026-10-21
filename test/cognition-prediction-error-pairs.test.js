'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Graph = require('../graph');
const { recordPrediction, recordOutcome } = require('../lib/prediction-outcome-pairs');
const { readPredictionErrors } = require('../lib/cognition-prediction-error-pairs');

test('reads prediction pairs from a real Graph journal without writing', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cog-pairs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const graph = new Graph({ useSQLite: false, memoryPath: path.join(dir, 'memory.json') });
  const at = '2026-10-19T10:00:00.000Z';
  recordPrediction(graph, { decisionId: 'a', score: 80, actionClass: 'edit', at });
  recordOutcome(graph, { decisionId: 'a', outcome: 'rollback', idempotencyKey: 'o-a', at });
  recordPrediction(graph, { decisionId: 'b', score: 10, at });
  recordPrediction(graph, { decisionId: 'c', unknown: 'no model', at });
  const writes = [];
  const original = graph.runMutationOnce.bind(graph);
  graph.runMutationOnce = (...args) => { writes.push(args[0]); return original(...args); };

  const { status, errors } = readPredictionErrors(graph);

  assert.equal(status, 'MEASURED');
  assert.deepEqual(writes, []);
  assert.deepEqual(errors.map((e) => [e.decisionId, e.status, e.key]), [
    ['a', 'MEASURED', 'risk:edit'],
    ['b', 'ABSTAIN', 'risk:unclassified'],
    ['c', 'ABSTAIN', 'risk:unclassified'],
  ]);
  assert.equal(errors[0].signedError, 0);
  assert.equal(errors[1].reason, 'outcome_unknown_or_censored');
  assert.equal(errors[2].reason, 'prediction_unscored');
});

test('a graph that cannot be read is INSUFFICIENT, not an exception', () => {
  assert.deepEqual(readPredictionErrors(null), { status: 'INSUFFICIENT', errors: [] });
});
