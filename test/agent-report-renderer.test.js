'use strict';

/**
 * Direct coverage for the run report.
 *
 * Before `renderRunReport` was extracted from `Agent._renderReport` the only
 * thing asserting on the report was agent.test.js:110, which checks that the
 * text contains `Goal:`, `Judgement summary:` and `Result:`. Those are labels:
 * replacing every rendered value with a constant keeps all three assertions
 * green. The report is what an operator reads to decide what the agent did,
 * so the values are the part that matters.
 *
 * These tests pin the values. They exist because the extraction made the
 * renderer callable on its own, which is the point of having done it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderRunReport } = require('../lib/agent-report-renderer');

function state(overrides = {}) {
  return {
    goal: 'is a cat an animal?',
    objective: 'establish the relation',
    status: 'completed',
    completedSteps: 2,
    progress: { stalledCount: 1 },
    finalAnswer: 'yes',
    steps: [
      { action: 'search', tool: 'graph', summary: 'found the edge' },
      { action: 'verify', tool: 'kernel' },
    ],
    finalSummary: {
      mode: 'evidence',
      knownFacts: ['a cat is an animal'],
      unknowns: [],
      conclusion: 'supported',
      nextQuestions: ['is a cat a mammal?'],
    },
    ...overrides,
  };
}

const guidance = {
  recommendations: {
    items: ['keep the evidence chain'],
    toolHealth: [{ tool: 'graph', success: 3, blocked: 0, error: 1 }],
  },
  nextAction: { action: 'verify', tool: 'kernel', reason: 'one edge is unconfirmed' },
};

test('the report carries the run values, not just their labels', () => {
  const report = renderRunReport(state(), guidance);

  assert.match(report, /^Goal: is a cat an animal\?$/m);
  assert.match(report, /^Objective: establish the relation$/m);
  assert.match(report, /^Status: completed$/m);
  assert.match(report, /^Steps completed: 2$/m);
  assert.match(report, /^Progress: stalled=1$/m);
  assert.match(report, /^Next step: verify -> kernel: one edge is unconfirmed$/m);
  assert.match(report, /^- Mode: evidence$/m);
  assert.match(report, /^- Conclusion: supported$/m);
  assert.match(report, /^Result: yes$/m);
});

test('every step is listed in order, with its summary when it has one', () => {
  const report = renderRunReport(state(), guidance);

  assert.match(report, /^1\. search \(graph\) - found the edge$/m);
  assert.match(report, /^2\. verify \(kernel\)$/m);
});

test('tool health reports the per-tool counts', () => {
  const report = renderRunReport(state(), guidance);

  assert.match(report, /^- graph: success=3, blocked=0, error=1$/m);
});

test('an absent tool-health record says so rather than rendering nothing', () => {
  const report = renderRunReport(state(), {
    ...guidance,
    recommendations: { items: [], toolHealth: [] },
  });

  assert.match(report, /^- no usage data yet$/m);
});

test('empty known, unknown and follow-up sections render as none', () => {
  const report = renderRunReport(
    state({
      finalSummary: {
        mode: 'insufficient', knownFacts: [], unknowns: [], conclusion: 'unknown', nextQuestions: [],
      },
    }),
    guidance,
  );

  const lines = report.split('\n');
  assert.equal(lines[lines.indexOf('Known:') + 1], '- none');
  assert.equal(lines[lines.indexOf('Unknown:') + 1], '- none');
  assert.equal(lines[lines.indexOf('Follow-up questions:') + 1], '- none');
});

test('a run with no progress counter says unknown rather than stalled=undefined', () => {
  const report = renderRunReport(state({ progress: undefined }), guidance);

  assert.match(report, /^Progress: unknown$/m);
});

test('a supplied final summary is used instead of being rebuilt from the state', () => {
  const report = renderRunReport(
    state({ finalSummary: { mode: 'supplied', knownFacts: [], unknowns: [], conclusion: 'as given', nextQuestions: [] } }),
    guidance,
  );

  assert.match(report, /^- Mode: supplied$/m);
  assert.match(report, /^- Conclusion: as given$/m);
});
