'use strict';

/**
 * AB10 integration behavior in AgentV3.
 *
 * These deliberately construct AgentV3 with an injected fake storage and no
 * kernel, so they exercise the budget path without requiring better-sqlite3.
 * The SQLite-backed end-to-end cases live in agent.v3.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const AgentV3 = require('../agent.v3.js');

function agentWith(storage, opts = {}) {
  return new AgentV3({ storage, baseAgent: {}, kernel: null, ...opts });
}

// ─── unreadable usage fails closed ───────────────────────────────────────────

test('a storage without sumAgentIterationsSince fails closed, not open', () => {
  const budget = agentWith({})._checkAgentLoopBudget('ws', {}, 3);
  assert.equal(budget.usageKnown, false);
  assert.equal(budget.decision, 'block');
  assert.equal(budget.reason, 'budget_usage_unavailable');
  assert.equal(budget.iterationsUsed, null,
    'unmeasured usage must not be reported as a number');
});

test('a throwing usage lookup fails closed and keeps the cause', () => {
  const budget = agentWith({
    sumAgentIterationsSince() { throw new Error('database is locked'); },
  })._checkAgentLoopBudget('ws', {}, 3);
  assert.equal(budget.usageKnown, false);
  assert.equal(budget.decision, 'block');
  assert.match(budget.detail, /database is locked/);
});

test('a non-numeric usage lookup result fails closed', () => {
  for (const value of [undefined, null, 'many', NaN, {}]) {
    const budget = agentWith({
      sumAgentIterationsSince: () => value,
    })._checkAgentLoopBudget('ws', {}, 3);
    assert.equal(budget.usageKnown, false, `${String(value)} must not pass as a usage figure`);
  }
});

test('a readable counter reports usage as known', () => {
  const budget = agentWith({ sumAgentIterationsSince: () => 5 })._checkAgentLoopBudget('ws', {}, 3);
  assert.equal(budget.usageKnown, true);
  assert.equal(budget.decision, 'allow');
  assert.equal(budget.iterationsUsed, 5);
});

test('a genuinely zero counter is allowed, and is distinct from an unreadable one', () => {
  const zero = agentWith({ sumAgentIterationsSince: () => 0 })._checkAgentLoopBudget('ws', {}, 3);
  const missing = agentWith({})._checkAgentLoopBudget('ws', {}, 3);
  assert.equal(zero.usageKnown, true);
  assert.equal(zero.decision, 'allow');
  assert.equal(missing.usageKnown, false);
  assert.notEqual(zero.decision, missing.decision);
});

// ─── requested iterations reflect real capacity ──────────────────────────────

test('the budget is asked only for the iterations this run can perform', () => {
  const budget = agentWith({ sumAgentIterationsSince: () => 10 })._checkAgentLoopBudget('ws', {}, 4);
  assert.equal(budget.requestedIterations, 4);
});

test('a small run near the threshold is not tripped into review by the per-call ceiling', () => {
  // The reported case: maxSteps 4, window limit 200, 110 already used.
  // Asking for the per-call ceiling (50) projects 160, which is exactly the
  // 0.8 review threshold and returns REVIEW; asking for the 4 steps the run
  // can actually take projects 114 and stays within budget.
  const storage = { sumAgentIterationsSince: () => 110 };

  const clamped = agentWith(storage)._checkAgentLoopBudget('ws', { maxIterations: 50 }, 4);
  assert.equal(clamped.decision, 'allow', 'a 4-step run must not be blocked while 90 iterations remain');

  const unclamped = agentWith(storage)._checkAgentLoopBudget('ws', { maxIterations: 50 }, null);
  assert.equal(unclamped.decision, 'review',
    'without a real capacity figure the per-call ceiling still governs (documents the old behavior)');
});

test('a genuinely exhausted budget is still blocked', () => {
  const budget = agentWith({ sumAgentIterationsSince: () => 500 })
    ._checkAgentLoopBudget('ws', {}, 1);
  assert.equal(budget.usageKnown, true);
  assert.equal(budget.decision, 'block');
  assert.equal(budget.reason, 'iteration_limit_exceeded');
});

test('an invalid capacity figure falls back to the configured ceiling', () => {
  const storage = { sumAgentIterationsSince: () => 1 };
  for (const capacity of [0, -3, null, NaN]) {
    const budget = agentWith(storage)._checkAgentLoopBudget('ws', { maxIterations: 7 }, capacity);
    assert.equal(budget.requestedIterations, 7, `${String(capacity)} should fall back, not request zero`);
  }
});

// ─── audit write failures do not mask the refusal ────────────────────────────

test('a throwing audit write does not turn a fail-closed refusal into an exception', () => {
  const agent = agentWith({}, {
    kernel: {
      graph: {
        appendAuditEvent() { throw new Error('sqlite is locked'); },
      },
    },
  });
  const budget = agent._checkAgentLoopBudget('ws', {}, 1);
  assert.doesNotThrow(() => agent._recordBudgetAuditEvent('goal', 'ws', budget));
});

test('a budget audit event records whether usage was measurable', () => {
  const events = [];
  const agent = agentWith({}, {
    kernel: { graph: { appendAuditEvent: (event) => events.push(event) } },
  });
  agent._recordBudgetAuditEvent('goal', 'ws', agent._checkAgentLoopBudget('ws', {}, 1));

  assert.equal(events.length, 1);
  assert.equal(events[0].targetType, 'agent_loop_budget');
  assert.equal(events[0].details.gate, 'AB10');
  assert.equal(events[0].details.usageKnown, false);
  assert.equal(events[0].eventType, 'REJECT');
});

test('a kernel without a graph is tolerated', () => {
  const agent = agentWith({}, { kernel: {} });
  assert.doesNotThrow(() => agent._recordBudgetAuditEvent('goal', 'ws', agent._checkAgentLoopBudget('ws', {}, 1)));
});
