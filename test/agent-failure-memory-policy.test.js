'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Agent = require('../agent');

function plannedStep(agent, goal, tool) {
  return agent.plan(goal).data.steps.find(step => step.tool === tool);
}

test('recent failure memory lowers the matching tool score across normalized plan signatures', () => {
  const agent = new Agent();
  const goal = 'Kediler balik yer mi';
  const ask = plannedStep(agent, goal, 'ask');

  const failure = agent._recordFailure(ask, { goal }, { error: { message: 'boom' } }, 1);
  assert.equal(failure.signature, 'ask|ask|kediler balik yer mi');

  const policy = agent.plan(goal).data.policy;
  assert.deepEqual(policy.failureHits, [{ tool: 'ask', error: 'boom', attempt: 1 }]);
  assert.ok(policy.signals.includes('recent-failure'));
  assert.equal(policy.toolScores.find(item => item.tool === 'ask').score, 71);
});

test('structured step inputs use the goal in failure signatures instead of a shared object bucket', () => {
  const agent = new Agent();
  const goal = 'Bu planin risklerini degerlendir';
  const dream = plannedStep(agent, goal, 'dream');

  const failure = agent._recordFailure(dream, { goal }, { error: { code: 'DREAM_FAILED' } }, 2);
  assert.equal(failure.signature, 'dream|dream|bu planin risklerini degerlendir');

  const policy = agent.plan(goal).data.policy;
  assert.deepEqual(policy.failureHits, [{ tool: 'dream', error: 'DREAM_FAILED', attempt: 2 }]);
  assert.ok(policy.signals.includes('recent-failure'));
});
