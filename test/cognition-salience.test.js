'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreSalience, DEFAULT_WEIGHTS, HABITUATION_HALF_LIFE } = require('../lib/cognition/salience');
const { keywordRelevance, scheduleCandidates } = require('../lib/cognitive-scheduler');

const candidate = (key, extra = {}) => ({ key, family: 'verify', perceptKey: 'pk:test',
  predictionError: { recentMean: 0.6 }, relevance: 1, riskTier: 'medium', arousal: 0.4, seenCount: 0, repeats: 0, ...extra });
const score = (row, goal) => scoreSalience({ candidates: [row], goal }).ranked[0];

test('scores the locked default formula with explicit components and signal-only authority', () => {
  const result = scoreSalience({ candidates: [candidate('step')] });
  assert.equal(result.status, 'MEASURED');
  assert.equal(result.authority, 'SIGNAL_ONLY');
  assert.equal(result.ranked[0].salience, 0.69);
  assert.deepEqual(result.ranked[0].components, { surprise: 0.6, goal: 1, risk: 0.5, arousal: 0.4, novelty: 1, habituation: 0 });
  assert.deepEqual(result.ranked[0].unknownComponents, []);
  assert.deepEqual(result.weights, DEFAULT_WEIGHTS);
});

test('ties and abstentions are deterministic without losing candidates', () => {
  const rows = [candidate('z'), { key: 'unknown' }, candidate('a')];
  const result = scoreSalience({ candidates: rows });
  assert.deepEqual(result, scoreSalience({ candidates: [...rows].reverse() }));
  assert.deepEqual(result.ranked.map((row) => row.key), ['a', 'z', 'unknown']);
  assert.equal(result.ranked[2].status, 'ABSTAIN');
  assert.equal(result.ranked[2].salience, null);
  const unicode = [candidate('\u00e9'), candidate('e\u0301')];
  assert.deepEqual(scoreSalience({ candidates: unicode }), scoreSalience({ candidates: [...unicode].reverse() }));
});

test('unknown primary signals abstain even when arousal and novelty are high', () => {
  const result = scoreSalience({ candidates: [{ key: 'step', arousal: 1, seenCount: 0, repeats: 0 }] });
  assert.equal(result.status, 'ABSTAIN');
  assert.equal(result.ranked[0].salience, null);
  assert.deepEqual(result.ranked[0].unknownComponents, ['surprise', 'goal', 'risk']);
  assert.equal(scoreSalience({ candidates: [] }).status, 'INSUFFICIENT');
});

test('invalid components contribute zero and remain visibly unknown', () => {
  const row = score({ key: 'step', relevance: 0, predictionError: { recentMean: NaN }, riskTier: 'constructor', arousal: Infinity, seenCount: -1, repeats: 0.5 });
  assert.equal(row.status, 'MEASURED');
  assert.equal(row.salience, 0);
  assert.deepEqual(row.unknownComponents, ['surprise', 'risk', 'arousal', 'novelty', 'habituation']);
  assert.equal(score(candidate('bad', { predictionError: { status: 'INSUFFICIENT', recentMean: 1 } })).components.surprise, 0);
});

test('reuses scheduler whole-token goal relevance and honors explicit zero', () => {
  for (const [goal, family] of [['task', 'ask'], ['verify changed files', 'verify'], ['LEARN facts', 'learn'], ['relearn', 'learn']]) {
    const row = score({ key: 'step', family }, goal);
    assert.equal(row.components.goal, keywordRelevance(goal, { family }));
    assert.ok(!row.unknownComponents.includes('goal'));
  }
  assert.equal(score(candidate('explicit', { relevance: 0 }), 'verify').components.goal, 0);
});

test('risk increases salience without altering the scheduler risk ceiling', () => {
  const low = score(candidate('low', { riskTier: 'low' }));
  const high = score(candidate('high', { riskTier: 'high' }));
  assert.ok(Math.abs(high.salience - low.salience - 0.2) < 1e-12);
  const scheduled = scheduleCandidates({ candidates: [{ key: 'high', family: 'verify', riskTier: 'high', urgency: high.salience }] }, { maxRiskTier: 'medium' });
  assert.deepEqual(scheduled.order, []);
  assert.equal(scheduled.trail[0].reason, 'above_risk_ceiling');
});

test('habituation follows the half-life and novelty decreases with seen count', () => {
  const fresh = score(candidate('fresh'));
  const repeated = score(candidate('repeat', { repeats: HABITUATION_HALF_LIFE }));
  assert.equal(repeated.components.habituation, 0.5);
  assert.ok(repeated.salience < fresh.salience);
  assert.equal(score(candidate('seen', { seenCount: 9 })).components.novelty, 0.1);
});

test('accepts only complete finite weight sets and clamps the resulting score', () => {
  const weights = { surprise: 1, goal: 1, risk: 1, arousal: 1, novelty: 1, habituation: 0 };
  assert.equal(scoreSalience({ candidates: [candidate('high')] }, { weights }).ranked[0].salience, 1);
  assert.equal(scoreSalience({ candidates: [candidate('low', { repeats: 300 })] }, { weights: { surprise: 0, goal: 0, risk: 0, arousal: 0, novelty: 0, habituation: 1 } }).ranked[0].salience, 0);
  for (const weights of [null, { surprise: 1 }, { ...DEFAULT_WEIGHTS, goal: NaN }, { ...DEFAULT_WEIGHTS, surprise: -1 }, { ...DEFAULT_WEIGHTS, extra: 0 }]) {
    assert.equal(scoreSalience({ candidates: [candidate('step')] }, { weights }).status, 'REJECT');
  }
});

test('rejects malformed structure and duplicate keys with no partial ranking', () => {
  for (const input of [null, [], { candidates: null }, { candidates: [null] }, { candidates: [{ key: ' ' }] }, { candidates: [candidate('same'), candidate('same')] }, { candidates: [candidate('step', { extra: 1 })] }, { candidates: [], goal: 42 }]) {
    const result = scoreSalience(input);
    assert.equal(result.status, 'REJECT');
    assert.deepEqual(result.ranked, []);
  }
  assert.equal(scoreSalience({ candidates: [] }, { extra: true }).status, 'REJECT');
});

test('does not mutate inputs and deeply freezes outputs', () => {
  const input = { goal: 'verify', candidates: [candidate('step')] };
  const before = JSON.stringify(input);
  const result = scoreSalience(input);
  assert.equal(JSON.stringify(input), before);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.ranked[0].components));
  assert.ok(Object.isFrozen(result.ranked[0].unknownComponents));
});
