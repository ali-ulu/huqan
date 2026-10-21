'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Graph = require('../graph');
const { recordPrediction, recordOutcome, PAIR_STORE_VERSION } = require('../lib/prediction-outcome-pairs');
const { readValueLedger } = require('../lib/cognition-value-ledger-pairs');

const options = { workspaceId: 'default', asOf: '2090-01-01T00:00:00Z', historyBoundary: { at: '2090-01-01T00:00:00Z', decisionId: 'next' } };
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-m9-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const memoryPath = path.join(dir, 'graph.json');
  return { memoryPath, graph: new Graph({ useSQLite: false, memoryPath }) };
}

// Extended scoped journal fixtures exercise the reader contract, not a shipped producer.
function scopedPair(graph, i, workspaceId = 'default', outcome = 'confirmed') {
  const decisionId = `${workspaceId}-${i}`;
  graph.runMutationOnce(`prediction-outcome:prediction:${decisionId}`, () => ({
    predictionPair: true, storeVersion: PAIR_STORE_VERSION, workspaceId, decisionId,
    prediction: { score: 10, actionClass: 'edit', at: '2025-01-01T00:00:00Z' },
  }));
  graph.runMutationOnce(`prediction-outcome:outcome:${decisionId}`, () => ({
    predictionPair: true, storeVersion: PAIR_STORE_VERSION, workspaceId, decisionId,
    sourceGroup: `group:${i}`, sourceRefs: [`source:${i}`], outcome: { state: outcome, at: '2025-01-02T00:00:00Z' },
  }));
}

test('legacy producer records stay insufficient instead of inventing workspace or independence', (t) => {
  const { graph } = setup(t);
  recordPrediction(graph, { decisionId: 'legacy', score: 10, at: '2025-01-01T00:00:00Z' });
  recordOutcome(graph, { decisionId: 'legacy', outcome: 'confirmed', idempotencyKey: 'legacy-o', at: '2025-01-02T00:00:00Z' });
  const ledger = readValueLedger(graph, options);
  assert.equal(ledger.status, 'INSUFFICIENT');
  assert.equal(ledger.reason, 'source_scope_missing');
  assert.deepEqual(ledger.entries, []);
});

test('scoped journal fixtures rebuild the same ledger after fresh-process reopen without writes', (t) => {
  const { graph, memoryPath } = setup(t);
  for (let i = 1; i <= 3; i++) scopedPair(graph, i);
  scopedPair(graph, 4, 'other', 'rollback');
  const journalPath = graph.jsonJournalPath();
  const before = fs.readFileSync(journalPath, 'utf8');
  graph.runMutationOnce = () => assert.fail('reader attempted a write');
  const ledger = readValueLedger(graph, options);
  assert.equal(ledger.status, 'MEASURED');
  assert.equal(ledger.entries[0].value, 1);
  assert.equal(ledger.entries[0].nObserved, 3);
  assert.equal(ledger.entries[0].nIndependent, 3);
  const scoring = readValueLedger(graph, { ...options, historyBoundary: { ...options.historyBoundary, decisionId: 'default-3' } });
  assert.equal(scoring.entries[0].nObserved, 2);
  assert.equal(scoring.status, 'INSUFFICIENT');
  const code = `const Graph=require('./graph'); const {readValueLedger}=require('./lib/cognition-value-ledger-pairs'); console.log(JSON.stringify(readValueLedger(new Graph({useSQLite:false,memoryPath:process.argv[1]}),JSON.parse(process.argv[2]))));`;
  const reopened = spawnSync(process.execPath, ['-e', code, memoryPath, JSON.stringify(options)], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(reopened.status, 0, reopened.stderr);
  assert.deepEqual(JSON.parse(reopened.stdout), ledger);
  assert.equal(fs.readFileSync(journalPath, 'utf8'), before);
});

test('backdated outcomes committed after the decision boundary never enter history', (t) => {
  const { graph } = setup(t);
  scopedPair(graph, 1);
  const historical = { ...options, asOf: '2025-01-03T00:00:00Z', historyBoundary: { at: '2025-01-03T00:00:00Z', decisionId: 'next' } };
  assert.deepEqual(readValueLedger(graph, historical).entries, []);
  assert.deepEqual(readValueLedger(graph, { ...historical, asOf: options.asOf }).entries, []);
});

test('missing source version, availability and malformed scoped pairs fail closed', (t) => {
  const { graph } = setup(t);
  scopedPair(graph, 1);
  const rows = graph.getCommittedMutationResultsByPrefix('prediction-outcome:');
  const prediction = rows.find((row) => row.result.prediction);
  const readRows = (input) => readValueLedger({ getCommittedMutationResultsByPrefix: () => input }, options);
  assert.equal(readRows(null).status, 'INSUFFICIENT');
  assert.equal(readRows([{ ...prediction, result: { ...prediction.result, storeVersion: 'unknown' } }]).reason, 'unsupported_source_version');
  assert.equal(readRows([{ ...prediction, committedAt: null }]).reason, 'source_availability_unknown');
  assert.equal(readRows([{ ...prediction, result: { ...prediction.result, prediction: null } }]).status, 'REJECT');
  const invalidOrder = rows.map((row) => row.result.outcome ? { ...row, result: { ...row.result, outcome: { state: 'confirmed', at: '2024-01-01T00:00:00Z' } } } : row);
  assert.equal(readRows(invalidOrder).reason, 'invalid_pair_order');
  assert.deepEqual(readRows([...rows, { ...rows[0], committedAt: null, result: { ...rows[0].result, workspaceId: 'other' } }]), readRows(rows));
  assert.equal(readValueLedger(graph, { ...options, historyBoundary: null }).status, 'REJECT');
  assert.deepEqual(readRows([...rows].reverse()), readRows(rows));
});

test('reader rejects conflicting outcomes and handles unavailable journal honestly', (t) => {
  const { graph } = setup(t);
  scopedPair(graph, 1);
  graph.runMutationOnce('prediction-outcome:outcome:conflict', () => ({
    predictionPair: true, storeVersion: PAIR_STORE_VERSION, workspaceId: 'default', decisionId: 'default-1',
    outcome: { state: 'rollback', at: '2025-01-03T00:00:00Z' },
  }));
  assert.equal(readValueLedger(graph, options).status, 'REJECT');
  const unavailable = { getCommittedMutationResultsByPrefix() { throw Error('unavailable'); } };
  assert.equal(readValueLedger(unavailable, options).status, 'INSUFFICIENT');
  assert.equal(readValueLedger(null, options).status, 'INSUFFICIENT');
});
