'use strict';

/**
 * I1 Cognitive Scheduler unit contract (#3311, program #3306).
 *
 * The scheduler must decide an order that is deterministic, bounded, and
 * starvation-free, and it must not invent an information gain it cannot
 * measure. These tests pin exactly that, with no store and no model.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SCHEDULER_STATUS,
  SCHEDULER_STOP_REASONS,
  SCHEDULER_ERROR_CODES,
  scheduleCandidates,
  scoreCandidate,
} = require('../lib/cognitive-scheduler');

function candidate(key, over = {}) {
  return { key, family: over.family || key.split(':')[0], ...over };
}

test('deterministic order with an explicit key tie-break', () => {
  const input = { candidates: [candidate('b:1'), candidate('a:1'), candidate('a:2')], goal: '' };
  const first = scheduleCandidates(input);
  const second = scheduleCandidates({ candidates: [candidate('a:2'), candidate('b:1'), candidate('a:1')], goal: '' });
  assert.equal(first.status, SCHEDULER_STATUS.OK);
  // Equal scores tie on key, independent of input order.
  assert.deepEqual(first.order, ['a:1', 'a:2', 'b:1']);
  assert.deepEqual(second.order, first.order);
});

test('goal relevance and urgency raise a candidate above an otherwise equal one', () => {
  const low = scoreCandidate({ family: 'dream', relevance: null, urgency: 0, riskTier: 'low', cost: 1 }, 'dream task');
  const high = scoreCandidate({ family: 'ask', relevance: null, urgency: 1, riskTier: 'low', cost: 1 }, 'dream task');
  assert.ok(low > high, 'a goal-matching family must outrank an unrelated but urgent one');
  const result = scheduleCandidates({ candidates: [candidate('ask:1', { family: 'ask', urgency: 1 }), candidate('dream:1', { family: 'dream' })], goal: 'dream task' });
  assert.deepEqual(result.order, ['dream:1', 'ask:1']);
});

test('candidates above the risk ceiling are excluded, not silently ranked', () => {
  const result = scheduleCandidates({
    candidates: [candidate('safe:1', { riskTier: 'low' }), candidate('risky:1', { riskTier: 'high' })],
    goal: '',
  }, { maxRiskTier: 'medium' });
  assert.equal(result.status, SCHEDULER_STATUS.OK);
  assert.deepEqual(result.order, ['safe:1']);
  const excluded = result.trail.find((entry) => entry.key === 'risky:1');
  assert.equal(excluded.selected, false);
  assert.equal(excluded.reason, 'above_risk_ceiling');
  assert.deepEqual(result.eligibleFamilies, ['safe']);
});

test('the queue is bounded by depth and by budget with a named stop reason', () => {
  const depth = scheduleCandidates({ candidates: [candidate('a:1'), candidate('a:2'), candidate('a:3')] }, { maxDepth: 2 });
  assert.deepEqual(depth.order, ['a:1', 'a:2']);
  assert.equal(depth.stopReason, SCHEDULER_STOP_REASONS.DEPTH_EXCEEDED);

  const budget = scheduleCandidates({
    candidates: [candidate('a:1', { cost: 1 }), candidate('a:2', { cost: 1 }), candidate('a:3', { cost: 1 })],
    budget: 2,
  });
  assert.deepEqual(budget.order, ['a:1', 'a:2']);
  assert.equal(budget.budgetUsed, 2);
  assert.equal(budget.stopReason, SCHEDULER_STOP_REASONS.BUDGET_EXHAUSTED);

  const empty = scheduleCandidates({ candidates: [] });
  assert.equal(empty.stopReason, SCHEDULER_STOP_REASONS.QUEUE_EMPTY);
});

test('a high-scoring family cannot starve another that still has an eligible candidate', () => {
  const candidates = [
    candidate('A:1', { urgency: 1 }), candidate('A:2', { urgency: 1 }), candidate('A:3', { urgency: 1 }),
    candidate('B:1', { urgency: 0 }), candidate('B:2', { urgency: 0 }),
  ];
  const result = scheduleCandidates({ candidates }, { starvationWindow: 2 });
  assert.equal(result.status, SCHEDULER_STATUS.OK);
  const bIndex = result.order.indexOf('B:1');
  const a3Index = result.order.indexOf('A:3');
  assert.ok(bIndex !== -1, 'the lower-scoring family must still be scheduled');
  assert.ok(bIndex < a3Index, 'starvation guard must interleave B before the third A');
  assert.equal(result.trail.find((entry) => entry.key === 'B:1').reason, 'starvation_guard');
});

test('an unmeasurable information gain is unknown and never changes the order', () => {
  const withLabel = candidate('a:1', { informationGain: 0.9, informationGainSource: 'calibration-pair' });
  const withoutLabel = candidate('a:2', { informationGain: 0.9 });
  const result = scheduleCandidates({ candidates: [withoutLabel, withLabel] });
  const rowA = result.trail.find((entry) => entry.key === 'a:1');
  const rowB = result.trail.find((entry) => entry.key === 'a:2');
  assert.equal(rowA.informationGainStatus, 'measured');
  assert.equal(rowA.informationGain, 0.9);
  assert.equal(rowB.informationGainStatus, 'unknown');
  assert.equal(rowB.informationGain, null);
  // Same score for both; the order is the key tie-break, not the gain value.
  assert.deepEqual(result.order, ['a:1', 'a:2']);
});

test('malformed input is rejected with a typed code, never coerced', () => {
  assert.equal(scheduleCandidates({ candidates: 'nope' }).code, SCHEDULER_ERROR_CODES.INVALID_FIELD);
  assert.equal(scheduleCandidates({ candidates: [candidate('a:1'), candidate('a:1')] }).code, SCHEDULER_ERROR_CODES.DUPLICATE_KEY);
  assert.equal(scheduleCandidates({ candidates: [{ key: 'a:1' }] }).code, SCHEDULER_ERROR_CODES.MISSING_FIELD);
  assert.equal(scheduleCandidates({ candidates: [candidate('a:1', { riskTier: 'critical' })] }).code, SCHEDULER_ERROR_CODES.UNKNOWN_RISK_TIER);
  assert.equal(scheduleCandidates({ candidates: [candidate('a:1', { cost: -1 })] }).code, SCHEDULER_ERROR_CODES.INVALID_FIELD);
});
