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
  assert.equal(scheduleCandidates({ candidates: [candidate('a:1')] }, { tieBreak: 'nonsense' }).code, SCHEDULER_ERROR_CODES.INVALID_FIELD);
});

test('#3447: the objective role lifts the relied-on step when the goal names no tool', () => {
  // "öğren yeni kural" is objective `learn`; the goal names no tool, so without
  // the role signal every candidate would tie and fall to the key tie-break
  // (`confirm` < `ingest`). The role signal must pick the learn step instead.
  const candidates = [
    { key: 'ingest', family: 'learn' },
    { key: 'confirm', family: 'verify' },
  ];
  const withoutRole = scheduleCandidates({ candidates, goal: 'yeni kural' });
  assert.deepEqual(withoutRole.order, ['confirm', 'ingest'], 'without the role signal the key tie-break wins');

  const withRole = scheduleCandidates({ candidates, goal: 'yeni kural', objective: 'learn' });
  assert.deepEqual(withRole.order, ['ingest', 'confirm'], 'the learn objective must rank its relied-on step first');
});

test('#3447: the objective role is weaker than a goal-named tool', () => {
  // The goal names "dream" (relevance 1) while the objective is `learn` (role
  // 0.2). Even when the role candidate is urgent and the named one is a risky,
  // zero-urgency step, the named step must win: the role bonus can only
  // reorder within the non-goal tier.
  const named = scoreCandidate({ family: 'dream', relevance: null, urgency: 0, riskTier: 'high', cost: 1 }, 'dream kedi', 'learn');
  const role = scoreCandidate({ family: 'learn', relevance: null, urgency: 1, riskTier: 'low', cost: 1 }, 'dream kedi', 'learn');
  assert.ok(named > role, 'a goal-named family must outrank the objective role');
  const result = scheduleCandidates({
    candidates: [
      candidate('learn:1', { family: 'learn', urgency: 1, riskTier: 'low', cost: 1 }),
      candidate('dream:1', { family: 'dream', urgency: 0, riskTier: 'high', cost: 1 }),
    ],
    goal: 'dream kedi',
    objective: 'learn',
    budget: 1,
  }, { maxRiskTier: 'high' });
  assert.deepEqual(result.order, ['dream:1'], 'the goal-named step must hold a one-step budget');
});

test('#3447: input-order tie-break preserves the plan (FIFO) order on an exact tie', () => {
  const candidates = [candidate('b:1'), candidate('a:1'), candidate('c:1')];
  const byKey = scheduleCandidates({ candidates });
  assert.deepEqual(byKey.order, ['a:1', 'b:1', 'c:1'], 'the default tie-break stays the key order');

  const byInput = scheduleCandidates({ candidates }, { tieBreak: 'input-order' });
  assert.deepEqual(byInput.order, ['b:1', 'a:1', 'c:1'], 'input-order must keep the plan order on a tie');
});

test('#3447: relevance still outranks input order, so a named step still moves up', () => {
  const candidates = [candidate('ask:1', { family: 'ask' }), candidate('verify:1', { family: 'verify' }), candidate('dream:1', { family: 'dream' })];
  const result = scheduleCandidates({ candidates, goal: 'dream kedi', objective: 'investigate' }, { tieBreak: 'input-order' });
  assert.equal(result.order[0], 'dream:1', 'the goal-named step must lead even under input-order tie-break');
});
