'use strict';

// #4064 COG-M1, remaining acceptance criterion: the real producer -> journal ->
// matched agent observation path, exercised with positive, missing, other-scope
// and delayed/repeated/reordered outcomes. The prediction binds workspace/run/
// step/frame before execution; a later outcome matches only that identity, a
// repeated outcome replays instead of doubling, and a reordered (outcome before
// prediction) event is refused, so event order can never multiply learning.
//
// This drives lib/agent-cognition-observation.js (the producer AgentV3 uses)
// against a real Graph journal; nothing here is a fixture outcome row.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const Graph = require('../graph');
const { beginObservation, finishObservation } = require('../lib/agent-cognition-observation');
const { readPredictionPairs, recordOutcome } = require('../lib/prediction-outcome-pairs');
const { readValueLedger } = require('../lib/cognition-value-ledger-pairs');

const FRAME = { repo: 'fixture', branch: 'main', commit: 'v1', environment: 'test', actor: 'host',
  time: '2026-10-25T00:00:00Z', goal: 'observe the predeclared artifact', task: 'artifact-v1' };

function fixture(t) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'm1-ordering-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'artifact.txt');
  fs.writeFileSync(target, 'before');
  const graph = new Graph({ useSQLite: false, memoryPath: path.join(directory, 'graph.json') });
  const state = { workspaceId: 'default', observabilityRunId: 'run-1', goal: FRAME.goal };
  const step = { id: 'artifact', tool: 'ask', action: 'ask' };
  const opts = { cognitionFrame: FRAME, cognitionFileExpectations: { [step.id]: {
    workspaceId: 'default', path: target, sourceGroup: 'artifact-source',
    expectedDigest: createHash('sha256').update('after').digest('hex'), riskScore: 0 } } };
  return { directory, target, graph, state, step, opts };
}

const outcomes = (graph) => Object.values(readPredictionPairs(graph)).filter(pair => pair.outcome);
const ledger = (graph) => readValueLedger(graph, { workspaceId: 'default', asOf: '2090-01-01T00:00:00Z',
  historyBoundary: { at: '2090-01-01T00:00:00Z', decisionId: 'next' } });

test('a delayed outcome matches the recorded prediction identity and is consumed once', (t) => {
  const f = fixture(t);
  const pending = beginObservation(f);
  assert.ok(pending, 'the pre-action expectation binds before the effect');
  assert.equal(Object.keys(readPredictionPairs(f.graph)).length, 1);
  assert.equal(outcomes(f.graph).length, 0, 'a prediction with no outcome yet stays censored');

  // The effect and its observation arrive later, still bound to the same
  // decision id the prediction was recorded under.
  fs.writeFileSync(f.target, 'after');
  const observed = finishObservation({ ...f, pending, report: { status: 'done' } });
  assert.equal(observed.status, 'MEASURED');
  assert.equal(observed.outcome, 'confirmed');
  assert.equal(observed.replayed, false);
  assert.equal(observed.decisionId, pending.decisionId);
  assert.equal(outcomes(f.graph).length, 1);

  // The next selection reads the derived value from the same scoped history.
  const derived = ledger(f.graph);
  assert.equal(derived.status, 'INSUFFICIENT');
  assert.equal(derived.entries[0].nObserved, 1);
  assert.equal(derived.entries[0].nIndependent, 1);
});

test('a repeated outcome replays the immutable row instead of doubling the observation', (t) => {
  const f = fixture(t);
  const pending = beginObservation(f);
  fs.writeFileSync(f.target, 'after');
  assert.equal(finishObservation({ ...f, pending, report: { status: 'done' } }).replayed, false);

  // A second observation of the same decision returns the recorded outcome and
  // writes nothing new, even though the artifact changed again afterward.
  fs.writeFileSync(f.target, 'changed-again');
  const replay = finishObservation({ ...f, pending, report: { status: 'done' } });
  assert.equal(replay.replayed, true);
  assert.equal(replay.reason, 'artifact_outcome_replayed');
  assert.equal(replay.outcome, 'confirmed');
  assert.equal(outcomes(f.graph).length, 1, 'one decision keeps exactly one outcome');
  assert.equal(ledger(f.graph).entries[0].nObserved, 1);
});

test('a reordered outcome cannot precede its prediction or multiply learning', (t) => {
  const f = fixture(t);
  const pending = beginObservation(f);
  const recorded = readPredictionPairs(f.graph)[pending.decisionId].prediction.at;
  // An outcome timestamped before the prediction it is meant to settle is
  // refused, and no outcome row is written for it.
  assert.throws(() => recordOutcome(f.graph, { decisionId: pending.decisionId, outcome: 'confirmed',
    idempotencyKey: 'reordered', at: new Date(Date.parse(recorded) - 60_000).toISOString() }), /precedes prediction/);
  assert.equal(outcomes(f.graph).length, 0);
  // The genuine, later observation still lands once.
  fs.writeFileSync(f.target, 'after');
  assert.equal(finishObservation({ ...f, pending, report: { status: 'done' } }).outcome, 'confirmed');
  assert.equal(outcomes(f.graph).length, 1);
});

test('another scope and a missing effect never match the recorded prediction', (t) => {
  const f = fixture(t);
  const other = { ...f, state: { ...f.state, workspaceId: 'other' } };
  assert.equal(beginObservation(other), null, 'a foreign workspace cannot arm the same observation');

  const pending = beginObservation(f);
  assert.ok(pending);
  // The independent source is missing (the artifact is gone by outcome time), so
  // the observation abstains rather than trusting the reported step, and the
  // journal keeps only the censored prediction.
  fs.rmSync(f.target);
  const abstained = finishObservation({ ...f, pending, report: { status: 'done', result: { ok: true } } });
  assert.equal(abstained.status, 'ABSTAIN');
  assert.equal(outcomes(f.graph).length, 0);
});
