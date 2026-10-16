'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

// #2132 (#2123): WorkflowAgent chose the preferred tool order for a goal's
// objective through a switch that grows with every new objective. The orders
// are now a table. The first block recovers each objective's sequence through
// the ranking (a tool's preferredIndex is its position in the sequence) and
// pins it, so any drift in any objective is caught.

const WorkflowAgent = require('../workflow-agent');

const TOOL_NAMES = [
  'ask', 'verify', 'reason', 'learn', 'compare', 'dream', 'plan', 'inspect',
  'discoveryengine', 'experimentplanner', 'resultanalyzer', 'replicationchecker',
];
const TOOLS = TOOL_NAMES.map((name, order) => ({ name, description: '', order }));

function sequenceFor(objective) {
  const agent = new WorkflowAgent();
  return agent._rankTools('probe', TOOLS, objective)
    .filter((item) => item.preferredIndex >= 0)
    .sort((a, b) => a.preferredIndex - b.preferredIndex)
    .map((item) => item.tool.name);
}

const DEFAULT = ['ask', 'verify', 'reason'];
const EXPECTED = {
  learn: ['learn', 'verify', 'ask'],
  compare: ['ask', 'compare', 'verify'],
  reason: ['ask', 'reason', 'verify'],
  discover: ['discoveryengine', 'experimentplanner', 'resultanalyzer', 'replicationchecker'],
  verify: ['ask', 'verify', 'reason'],
  plan: ['ask', 'reason', 'verify'],
  inspect: DEFAULT,
};

describe('WorkflowAgent objective sequences (unchanged)', () => {
  for (const [objective, expected] of Object.entries(EXPECTED)) {
    it(`${objective} prefers ${expected.join(' > ')}`, () => {
      assert.deepEqual(sequenceFor(objective), expected);
    });
  }

  it('an unknown or prototype-named objective falls back to the default order', () => {
    for (const objective of ['nonsense', '', undefined, 'toString', '__proto__', 'constructor']) {
      assert.deepEqual(sequenceFor(objective), DEFAULT, String(objective));
    }
  });

  it('every objective the goal classifier returns has its own pinned order', () => {
    const agent = new WorkflowAgent();
    const goals = ['learn this', 'compare a vs b', 'why is it', 'run an experiment', 'verify it', 'plan the task', 'hello'];
    const objectives = goals.map((goal) => agent.plan(goal).objective);
    assert.deepEqual([...new Set(objectives)].sort(), Object.keys(EXPECTED).sort());
  });
});

describe('the objective sequences are a registry (#2132)', () => {
  it('workflow-agent.js no longer switches on the objective', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'workflow-agent.js'), 'utf8');
    assert.doesNotMatch(source, /switch\s*\(\s*objective\s*\)/);
  });

  it('the architecture snapshot no longer sees a growing dispatch here', () => {
    const row = require('../scripts/architecture-snapshot').snapshot().find((item) => item.file === 'workflow-agent.js');
    assert.ok(row, 'the file is measured');
    assert.ok(!row.signals.some((signal) => signal.startsWith('OCP')), JSON.stringify(row.signals));
  });
});
