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
  comparePredictionOutcome,
  predictionBindingHash,
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

function rewardFixture(decisionId = 'durable') {
  const binding = { workspaceId: 'default', runId: 'agent-run', stepId: 'coder:repair',
    frameHash: 'a'.repeat(64), expectationHash: 'b'.repeat(64), perceptKey: 'percept:repair',
    sourceGroup: 'independent-repair', sourceRefs: ['coder-run:native:c1', 'coder-run:native:c2'] };
  const rewardContext = { key: 'risk:coder:replace_text', expected: -1,
    history: { workspaceId: binding.workspaceId, frameHash: binding.frameHash,
      historyBoundary: { at: AT, decisionId, priorDecisionIds: ['prior-1', 'prior-2', 'prior-3'] } } };
  const acceptance = { sourceRef: 'coder-run:native:c2', sourceHash: 'c'.repeat(64),
    scopeHash: binding.expectationHash, runId: 'native:c2' };
  return { decisionId, score: 20, actionClass: 'coder:replace_text', at: AT, binding, rewardContext, acceptance };
}

test('predecision digest commits to the stored prediction and excludes later acceptance', t => {
  const dir = tempDir(t), graph = memoryGraph(dir), input = rewardFixture('digest');
  const recorded = recordPrediction(graph, input);
  assert.match(recorded.predictionHash, /^[a-f0-9]{64}$/);
  const before = readPredictionPairs(memoryGraph(dir)).digest;
  assert.equal(recorded.predictionHash, before.predictionHash);
  const replay = recordPrediction(graph, { ...input, at: '2026-01-01T00:00:01.000Z', score: 90 });
  assert.equal(replay.predictionHash, recorded.predictionHash, 'replay hashes the original stored prediction');
  recordOutcome(graph, { decisionId: input.decisionId, outcome: 'confirmed', idempotencyKey: 'digest-result',
    at: AT, acceptance: input.acceptance });
  const after = readPredictionPairs(memoryGraph(dir)).digest;
  assert.equal(after.predictionHash, before.predictionHash);
  for (const change of [pair => { pair.rewardContext.expected = 1; },
    pair => { pair.binding.frameHash = 'e'.repeat(64); },
    pair => { pair.prediction.at = '2026-01-01T00:00:01.000Z'; }]) {
    const changed = structuredClone(before); change(changed);
    assert.notEqual(predictionBindingHash(changed), before.predictionHash);
  }
  assert.equal(recordPrediction(graph, { decisionId: 'legacy-digest', score: 1, at: AT }).predictionHash, undefined);
});

test('reward context and selected native acceptance survive a Graph reopen', t => {
  const dir = tempDir(t), graph = memoryGraph(dir), input = rewardFixture();
  recordPrediction(graph, input);
  assert.deepEqual(readPredictionPairs(memoryGraph(dir))[input.decisionId].rewardContext, input.rewardContext);
  recordOutcome(graph, { decisionId: input.decisionId, outcome: 'confirmed', idempotencyKey: 'accepted',
    at: AT, acceptance: input.acceptance });
  const pair = readPredictionPairs(memoryGraph(dir))[input.decisionId];
  assert.deepEqual(pair.rewardContext, input.rewardContext);
  assert.deepEqual(pair.acceptance, input.acceptance);
  assert.deepEqual(pair.binding, input.binding);
});

test('contextual receipts use the same controlled clock as their timestamp producer', t => {
  const RealDate = Date, at = new RealDate(RealDate.now() + 60000).toISOString();
  t.mock.method(global, 'Date', class extends RealDate { constructor(...args) { super(...(args.length ? args : [at])); } });
  const graph = memoryGraph(tempDir(t)), input = rewardFixture();
  delete input.at; input.rewardContext.history.historyBoundary.at = at;
  recordPrediction(graph, input);
  recordOutcome(graph, { decisionId: input.decisionId, outcome: 'confirmed', idempotencyKey: 'clock', acceptance: input.acceptance });
  const pair = readPredictionPairs(graph)[input.decisionId];
  assert.equal(pair.prediction.at, at); assert.equal(pair.outcome.at, at);
  assert.deepEqual(pair.rewardContext, input.rewardContext);
});

test('frozen reward expectations cannot be replaced by replaying the prediction', t => {
  const graph = memoryGraph(tempDir(t)), input = rewardFixture();
  recordPrediction(graph, input);
  assert.equal(recordPrediction(graph, structuredClone(input)).replayed, true);
  const before = graph.getCommittedMutationResultsByPrefix('prediction-outcome:');
  for (const change of [context => { context.expected = 1; },
    context => { context.history.historyBoundary.priorDecisionIds.reverse(); },
    context => { context.history.historyBoundary.at = '2025-12-31T23:59:59.000Z'; }]) {
    const changed = structuredClone(input); change(changed.rewardContext);
    assert.throws(() => recordPrediction(graph, changed));
  }
  assert.deepEqual(graph.getCommittedMutationResultsByPrefix('prediction-outcome:'), before);
  input.rewardContext.expected = 1;
  assert.equal(readPredictionPairs(graph).durable.rewardContext.expected, -1, 'caller mutation does not rewrite history');
});

test('reward context rejects mismatched scope, future history, self-reference and invalid expectation', t => {
  const graph = memoryGraph(tempDir(t));
  const changes = [
    input => { delete input.binding; },
    input => { input.rewardContext.key = 'risk:ask'; },
    input => { input.rewardContext.history.workspaceId = 'foreign'; },
    input => { input.rewardContext.history.frameHash = 'd'.repeat(64); },
    input => { input.rewardContext.history.historyBoundary.decisionId = 'other'; },
    input => { input.rewardContext.history.historyBoundary.at = '2026-01-01T00:00:00.001Z'; },
    input => { input.rewardContext.history.historyBoundary.priorDecisionIds.push(input.decisionId); },
    ...[NaN, Infinity, -1.01, 1.01, '0', undefined].map(expected => input => { input.rewardContext.expected = expected; }),
  ];
  for (const change of changes) {
    const input = rewardFixture(); change(input);
    assert.throws(() => recordPrediction(graph, input), String(change));
    assert.deepEqual(readPredictionPairs(graph), {}, 'refused metadata leaves no prediction');
  }
  for (const expected of [null, -1, 0, 1]) {
    const input = rewardFixture(`expected-${expected}`); input.rewardContext.expected = expected;
    recordPrediction(graph, input);
    assert.equal(readPredictionPairs(graph)[input.decisionId].rewardContext.expected, expected);
  }
});

test('native acceptance is bound to the predeclared source and same-key replay cannot change evidence', t => {
  const graph = memoryGraph(tempDir(t)), input = rewardFixture();
  recordPrediction(graph, input);
  const outcome = { decisionId: input.decisionId, outcome: 'confirmed', idempotencyKey: 'native-accepted',
    at: AT, acceptance: input.acceptance };
  for (const patch of [{ sourceRef: 'coder-run:foreign' }, { runId: 'native:c1' },
    { runId: ' native:c2 ' }, { sourceHash: { toString: () => 'c'.repeat(64) } },
    { scopeHash: 'e'.repeat(64) }, { sourceHash: 'not-a-hash' }, { extra: 'unapproved' }])
    assert.throws(() => recordOutcome(graph, { ...outcome, acceptance: { ...input.acceptance, ...patch } }));
  assert.equal(readPredictionPairs(graph).durable.outcome, null);
  assert.equal(recordOutcome(graph, outcome).replayed, false);
  assert.equal(recordOutcome(graph, structuredClone(outcome)).replayed, true);
  const before = graph.getCommittedMutationResultsByPrefix('prediction-outcome:');
  for (const changed of [{ ...outcome, acceptance: { ...input.acceptance, sourceHash: 'f'.repeat(64) } },
    { ...outcome, acceptance: { ...input.acceptance, sourceRef: 'coder-run:native:c1', runId: 'native:c1' } },
    { ...outcome, acceptance: undefined }, { ...outcome, outcome: 'contradiction' }])
    assert.throws(() => recordOutcome(graph, changed));
  assert.deepEqual(graph.getCommittedMutationResultsByPrefix('prediction-outcome:'), before);
  input.acceptance.sourceHash = '0'.repeat(64);
  assert.equal(readPredictionPairs(graph).durable.acceptance.sourceHash, 'c'.repeat(64));
});

test('persisted contextual pairs reject changed outcome scope and future or reversed timestamps', t => {
  const graph = memoryGraph(tempDir(t)), input = rewardFixture();
  recordPrediction(graph, input);
  recordOutcome(graph, { decisionId: input.decisionId, outcome: 'confirmed', idempotencyKey: 'accepted',
    at: AT, acceptance: input.acceptance });
  const original = graph.getCommittedMutationResultsByPrefix('prediction-outcome:');
  for (const change of [row => { row.workspaceId = 'other'; }, row => { row.frameHash = 'd'.repeat(64); },
    row => { row.outcome.at = '2025-12-31T23:59:59.000Z'; }, row => { row.outcome.at = '2999-01-01T00:00:00.000Z'; }]) {
    const rows = structuredClone(original); change(rows.find(row => row.result.outcome).result);
    const reader = { runMutationOnce() { throw new Error('read-only'); }, getCommittedMutationResultsByPrefix: () => rows };
    assert.throws(() => readPredictionPairs(reader), /persisted outcome binding/);
  }
  assert.deepEqual(graph.getCommittedMutationResultsByPrefix('prediction-outcome:'), original);
});

test('legacy pair read shape stays unchanged without durable reward metadata', t => {
  const graph = memoryGraph(tempDir(t));
  recordPrediction(graph, { decisionId: 'legacy', score: 10, at: AT, binding: rewardFixture().binding });
  recordOutcome(graph, { decisionId: 'legacy', outcome: 'confirmed', idempotencyKey: 'legacy-result', at: AT });
  assert.deepEqual(readPredictionPairs(graph).legacy, { decisionId: 'legacy',
    prediction: { score: 10, unknown: '', actionClass: null, at: AT }, outcome: { state: 'confirmed', at: AT } });
});

test('a bound acceptance remains readable when reward was not enabled', t => {
  const graph = memoryGraph(tempDir(t)), input = rewardFixture('no-reward');
  delete input.rewardContext;
  recordPrediction(graph, input);
  recordOutcome(graph, { decisionId: input.decisionId, outcome: 'confirmed', idempotencyKey: 'no-reward-result',
    at: AT, acceptance: input.acceptance });
  const pair = readPredictionPairs(graph)[input.decisionId];
  assert.deepEqual(pair.acceptance, input.acceptance);
  assert.deepEqual(pair.binding, input.binding);
  assert.equal(pair.rewardContext, undefined);
});

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

test('comparison agrees, misses and false-alarms on the canonical high band', () => {
  assert.deepEqual(comparePredictionOutcome({ score: 80, outcome: 'incident' }), {
    agrees: true, predictedHigh: true, reason: 'high_estimate_met_adverse_outcome',
  });
  assert.deepEqual(comparePredictionOutcome({ score: 20, outcome: 'incident' }), {
    agrees: false, predictedHigh: false, reason: 'missed_adverse_outcome',
  });
  assert.deepEqual(comparePredictionOutcome({ score: 80, outcome: 'confirmed' }), {
    agrees: false, predictedHigh: true, reason: 'false_alarm',
  });
  assert.deepEqual(comparePredictionOutcome({ score: 20, outcome: 'confirmed' }), {
    agrees: true, predictedHigh: false, reason: 'low_estimate_confirmed',
  });
  for (const outcome of ['rollback', 'compensation', 'contradiction', 'reviewer-rejection']) {
    assert.equal(comparePredictionOutcome({ score: 90, outcome }).agrees, true, outcome);
  }
});

test('unscored predictions and unknown outcomes never agree nor disagree', () => {
  for (const input of [
    { score: null, outcome: 'incident' },
    { score: 80, outcome: null },
    { score: 80, outcome: 'censored' },
    { score: 80, outcome: 'exploded' },
    {},
  ]) {
    assert.equal(comparePredictionOutcome(input).agrees, null, JSON.stringify(input));
  }
  assert.equal(comparePredictionOutcome({ score: 50, outcome: 'confirmed' }).predictedHigh, true);
});
