'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { OUTCOMES } = require('../lib/prediction-outcome-pairs');
const { computeRewardSignal, rewardForOutcome, REWARD_BY_OUTCOME, RPE_BOUND } = require('../lib/cognition/reward-signal');

const base = { source: 'prediction-outcome', key: 'rule:default/r1', decisionId: 'd1', at: '2026-10-21T10:00:00Z', expected: null };

test('maps every named outcome and abstains on missing or censored observations', () => {
  assert.deepEqual(Object.keys(REWARD_BY_OUTCOME).sort(), [...OUTCOMES].sort());
  for (const outcome of OUTCOMES) {
    const result = computeRewardSignal({ ...base, outcome });
    assert.equal(result.reward, REWARD_BY_OUTCOME[outcome]);
    assert.equal(rewardForOutcome(outcome), result.reward);
    assert.equal(result.status, outcome === 'censored' ? 'ABSTAIN' : 'MEASURED');
    assert.equal(result.authority, 'SIGNAL_ONLY');
  }
  for (const outcome of [undefined, null, 'ok', 'unknown', '__proto__', 'constructor']) {
    assert.equal(rewardForOutcome(outcome), null);
    const result = computeRewardSignal({ ...base, outcome });
    assert.equal(result.status, 'ABSTAIN');
    assert.equal(result.rpe, null);
  }
});

test('reported success and unknown eligibility never earn reward', () => {
  assert.equal(computeRewardSignal({ ...base, source: 'step-report', status: 'ok' }).reason, 'reported_not_observed');
  for (const eligibility of [undefined, 'ok', 'constructor']) {
    assert.equal(computeRewardSignal({ ...base, source: 'experience-journal', eligibility }).status, 'ABSTAIN');
  }
  for (const [eligibility, reward] of [['positive_procedure', 1], ['negative_example', -1]]) {
    assert.equal(computeRewardSignal({ ...base, source: 'experience-journal', eligibility }).reward, reward);
  }
});

test('uses labeled prior or explicit expectation and bounded signed RPE', () => {
  const prior = computeRewardSignal({ ...base, outcome: 'confirmed' });
  assert.equal(prior.expected, 0);
  assert.equal(prior.expectedSource, 'prior');
  assert.equal(prior.rpe, 1);
  const negative = computeRewardSignal({ ...base, outcome: 'rollback', expected: 1 });
  assert.equal(negative.rpe, -RPE_BOUND);
  assert.equal(negative.expectedSource, 'value-ledger');
  assert.equal(computeRewardSignal({ ...base, outcome: 'confirmed', expected: -1 }).rpe, RPE_BOUND);
  assert.equal(computeRewardSignal({ ...base, outcome: 'compensation' }).reward, -0.5);
});

test('rejects malformed expectation, identity, timestamp, source and unknown fields', () => {
  for (const expected of [NaN, Infinity, -Infinity, -1.01, 1.01, '0', undefined]) {
    assert.equal(computeRewardSignal({ ...base, outcome: 'confirmed', expected }).status, 'REJECT');
  }
  for (const patch of [{ key: '' }, { decisionId: ' ' }, { at: 'bad' }, { source: 'unknown' }, { source: ['prediction-outcome'] }, { extra: true }, { eligibility: 'positive_procedure' }]) {
    assert.equal(computeRewardSignal({ ...base, outcome: 'confirmed', ...patch }).status, 'REJECT');
  }
  for (const input of [null, [], 1]) assert.equal(computeRewardSignal(input).status, 'REJECT');
});

test('returns deterministic frozen results without mutating input', () => {
  const input = Object.freeze({ ...base, outcome: 'incident', expected: 0.3333333 });
  const result = computeRewardSignal(input);
  assert.equal(result.rpe, -1.333333);
  assert.equal(result.at, '2026-10-21T10:00:00.000Z');
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(result, computeRewardSignal(input));
  assert.equal(input.expected, 0.3333333);
});

test('derives rewards from real prediction pairs without writing', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const Graph = require('../graph');
  const { recordPrediction, recordOutcome, readPredictionPairs } = require('../lib/prediction-outcome-pairs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cog-reward-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const graph = new Graph({ useSQLite: false, memoryPath: path.join(dir, 'memory.json') });
  recordPrediction(graph, { decisionId: 'd1', score: 10, at: base.at });
  recordOutcome(graph, { decisionId: 'd1', outcome: 'rollback', idempotencyKey: 'o1', at: '2026-10-21T10:01:00Z' });
  recordPrediction(graph, { decisionId: 'd2', score: 10, at: base.at });
  graph.runMutationOnce = () => assert.fail('reward reads must not write');
  const pairs = Object.values(readPredictionPairs(graph)).sort((a, b) => a.decisionId.localeCompare(b.decisionId));
  const results = pairs.map((pair) => computeRewardSignal({ ...base, decisionId: pair.decisionId, outcome: pair.outcome ? pair.outcome.state : null }));
  assert.deepEqual(results.map((r) => [r.status, r.reward]), [['MEASURED', -1], ['ABSTAIN', null]]);
});
