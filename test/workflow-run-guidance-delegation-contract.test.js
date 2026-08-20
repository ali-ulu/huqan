'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const WorkflowAgent = require('../workflow-agent');
const guidance = require('../lib/workflow-run-guidance');

const runtimeSource = fs.readFileSync(path.join(__dirname, '..', 'workflow-agent.js'), 'utf8');
const delegateSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'workflow-run-guidance.js'), 'utf8');

function run(overrides = {}) {
  return {
    goal: 'test goal',
    objective: 'inspect',
    status: 'completed',
    steps: [],
    confidence: 0.8,
    nextAction: { action: 'none', tool: null },
    finalSummary: {
      mode: 'direct',
      knownFacts: ['fact'],
      unknowns: [],
      conclusion: 'done',
      nextQuestions: [],
    },
    recommendations: [],
    trace: [],
    evidence: [{ id: 'e-1' }],
    finalAnswer: 'answer',
    ...overrides,
  };
}

test('WorkflowAgent run-guidance helpers are cycle-free shared delegates', () => {
  assert.match(runtimeSource, /const \{\n  buildReport,\n  deriveNextAction,\n  buildRecommendations,\n\} = require\('\.\/lib\/workflow-run-guidance'\);/);
  assert.doesNotMatch(delegateSource, /require\(['"].*workflow-agent/);
  assert.doesNotMatch(delegateSource, /\bthis\./);
  assert.doesNotMatch(delegateSource, /\._(tools|registry|storage|memory|nodes|edges|db|stmts)/);
  assert.deepEqual(Object.keys(guidance), ['buildReport', 'deriveNextAction', 'buildRecommendations']);
  assert.equal(typeof WorkflowAgent, 'function');
});

test('report projection preserves final summary, trace and recommendation formatting', () => {
  const report = guidance.buildReport(run({
    nextAction: { action: 'continue', tool: 'ask' },
    recommendations: ['Collect more evidence.'],
    trace: [{ stepId: 'step-1', tool: 'ask', status: 'done', score: 0.8 }],
  }));

  assert.match(report, /Goal: test goal/);
  assert.match(report, /Objective: inspect/);
  assert.match(report, /Status: completed/);
  assert.match(report, /Next action: continue -> ask/);
  assert.match(report, /- Mode: direct/);
  assert.match(report, /- fact/);
  assert.match(report, /- Conclusion: done/);
  assert.match(report, /- step-1: ask done score=0\.8/);
  assert.match(report, /- Collect more evidence\./);
  assert.match(report, /Final answer: answer/);
});

test('next-action decisions remain fail-closed across terminal and partial states', () => {
  assert.deepEqual(guidance.deriveNextAction(run({ status: 'completed' }), []), {
    action: 'none', tool: null, reason: 'Workflow completed.',
  });
  assert.deepEqual(guidance.deriveNextAction(run({ status: 'paused' }), [{ tool: 'verify' }]), {
    action: 'resume', tool: 'verify', reason: 'Step or budget limit reached.',
  });
  assert.deepEqual(guidance.deriveNextAction(run({ status: 'blocked' }), [{ tool: 'ask' }]), {
    action: 'revise', tool: null, reason: 'Unknown or blocked tool must be replaced.',
  });
  assert.deepEqual(guidance.deriveNextAction(run({ status: 'partial', steps: [{ tool: 'reason' }] }), []), {
    action: 'repair', tool: 'reason', reason: 'A step failed; retry or simplify the plan.',
  });
  assert.deepEqual(guidance.deriveNextAction(run({ status: 'failed' }), []), {
    action: 'repair', tool: null, reason: 'No step completed successfully.',
  });
});

test('recommendations preserve status, evidence, confidence and review signals', () => {
  assert.deepEqual(guidance.buildRecommendations(run({
    status: 'paused',
    evidence: [],
    confidence: 0.4,
    trace: [{ policyAction: 'review' }],
  })), [
    'Resume from the remaining steps.',
    'Increase maxSteps or budget only if needed.',
    'Add at least one tool that can produce evidence.',
    'Collect more evidence before concluding.',
    'Review policy-gated tools before re-running.',
  ]);
  assert.deepEqual(guidance.buildRecommendations(run({
    status: 'blocked',
    evidence: [{ id: 'e-1' }],
    confidence: 0.9,
    trace: [],
  })), ['Replace the unknown or blocked tool with a registered internal tool.']);
});

test('WorkflowAgent run output continues to use the delegated helpers', async () => {
  const agent = new WorkflowAgent({ maxSteps: 1 });
  agent.registerTool({
    name: 'ask',
    kind: 'internal',
    run: () => ({ ok: true, data: { answer: 'answer' }, evidence: ['e-1'], confidence: 0.9 }),
  });
  const result = await agent.run('test goal');
  assert.equal(result.status, 'completed');
  assert.equal(result.nextAction.action, 'none');
  assert.ok(result.report.includes('Next action: none'));
  assert.ok(result.recommendations.includes('No immediate action required.'));
});
