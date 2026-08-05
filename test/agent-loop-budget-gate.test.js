const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AGENT_LOOP_BUDGET_DECISIONS,
  AGENT_LOOP_BUDGET_REASONS,
  evaluateAgentLoopBudget,
} = require('../lib/agent-loop-budget-gate');

test('allows a fresh workspace well under budget', () => {
  const result = evaluateAgentLoopBudget({ iterationsUsed: 0, requestedIterations: 10 }, { maxIterationsPerWindow: 200 });
  assert.equal(result.decision, AGENT_LOOP_BUDGET_DECISIONS.ALLOW);
  assert.equal(result.reason, AGENT_LOOP_BUDGET_REASONS.WITHIN_BUDGET);
  assert.equal(result.remaining, 200);
});

test('reviews when the requested run would push usage past the review threshold', () => {
  const result = evaluateAgentLoopBudget(
    { iterationsUsed: 150, requestedIterations: 30 },
    { maxIterationsPerWindow: 200, reviewThresholdRatio: 0.8 },
  );
  assert.equal(result.decision, AGENT_LOOP_BUDGET_DECISIONS.REVIEW);
  assert.equal(result.reason, AGENT_LOOP_BUDGET_REASONS.APPROACHING_LIMIT);
});

test('blocks fail-closed once the window budget is already exhausted', () => {
  const result = evaluateAgentLoopBudget({ iterationsUsed: 200 }, { maxIterationsPerWindow: 200 });
  assert.equal(result.decision, AGENT_LOOP_BUDGET_DECISIONS.BLOCK);
  assert.equal(result.reason, AGENT_LOOP_BUDGET_REASONS.LIMIT_EXCEEDED);
  assert.equal(result.remaining, 0);
});

test('blocks even further over budget (does not "un-block" past the ceiling)', () => {
  const result = evaluateAgentLoopBudget({ iterationsUsed: 500 }, { maxIterationsPerWindow: 200 });
  assert.equal(result.decision, AGENT_LOOP_BUDGET_DECISIONS.BLOCK);
});

test('a small requested run near the ceiling stays ALLOW if it would not cross the review threshold', () => {
  const result = evaluateAgentLoopBudget(
    { iterationsUsed: 10, requestedIterations: 5 },
    { maxIterationsPerWindow: 200, reviewThresholdRatio: 0.8 },
  );
  assert.equal(result.decision, AGENT_LOOP_BUDGET_DECISIONS.ALLOW);
});

test('default options apply when none are given', () => {
  const result = evaluateAgentLoopBudget({ iterationsUsed: 0 });
  assert.equal(result.decision, AGENT_LOOP_BUDGET_DECISIONS.ALLOW);
  assert.equal(result.maxIterationsPerWindow, 200);
});

test('negative/garbage usage input is clamped, never produces a negative-budget false ALLOW', () => {
  const result = evaluateAgentLoopBudget({ iterationsUsed: -50 }, { maxIterationsPerWindow: 200 });
  assert.equal(result.iterationsUsed, 0);
  assert.equal(result.decision, AGENT_LOOP_BUDGET_DECISIONS.ALLOW);
});
