'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const WorkflowAgent = require('../workflow-agent');

function ranked(...items) {
  return items.map((name, order) => ({
    tool: { name, cost: name === 'expensive' ? 11 : 2, order },
  }));
}

test('budget selection skips an unaffordable preferred tool and keeps later affordable tools', () => {
  const agent = new WorkflowAgent({ budget: 10 });
  const selected = agent._selectStepTools('inspect', ranked('expensive', 'cheap-one', 'cheap-two'), 'inspect', 3, 10);
  assert.deepEqual(selected.map(item => item.tool.name), ['cheap-one', 'cheap-two']);
});

test('budget selection skips an unaffordable ranked tool instead of truncating the candidate list', () => {
  const agent = new WorkflowAgent({ budget: 10 });
  const selected = agent._selectStepTools('inspect', ranked('expensive', 'cheap-one', 'cheap-two'), 'other', 3, 4);
  assert.deepEqual(selected.map(item => item.tool.name), ['cheap-one', 'cheap-two']);
});
