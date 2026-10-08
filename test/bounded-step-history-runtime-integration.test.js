'use strict';

/**
 * #3618 (R53): the bounded-history tallies survive the runtime seams.
 *
 * A trimmed run's tallies live as a property of the step array, which is not
 * JSON-safe. Three seams must carry them so a long run never loses its true
 * step count: the durable run entry (`_rememberRun`), the V1 resume state
 * (`createRunState`/`executeAgentRun`), and the V3 checkpoint
 * (`saveRunCheckpoint`/`hydrateRunState`, covered in bounded-step-history.test.js).
 * A run that was never trimmed must stay byte-identical.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { memoryRuntime } = require('../lib/agent-memory-runtime');
const { defaultMemoryState } = require('../lib/agent-memory-state');
const { executeAgentRun } = require('../lib/agent-step-executor');
const { summarizeStepHistory } = require('../lib/bounded-step-history');

const TALLIES = {
  count: 40,
  statuses: { done: 38, blocked: 2 },
  usage: { tokens: 400, inputTokens: 240, outputTokens: 160, costMicros: 0 },
  usageUnknown: { tokens: false, inputTokens: false, outputTokens: false, costMicros: true },
  usageKnown: true,
};

function memoryRuntimeWith(overrides = {}) {
  return Object.assign({
    memory: defaultMemoryState(),
    memoryPath: null,
    storage: null,
    ...overrides,
  }, memoryRuntime);
}

function stepsWithTallies() {
  const steps = [{ action: 'a', status: 'done', result: { usage: { tokens: 5 } } }];
  steps.stepHistoryTotals = TALLIES;
  return steps;
}

test('_rememberRun carries the tallies only when the history was actually trimmed', () => {
  const runtime = memoryRuntimeWith();
  const trimmed = runtime._rememberRun({
    id: 'run-trimmed', goal: 'g', objective: 'o', steps: stepsWithTallies(),
    queuedSteps: [], evidence: [], notes: [], status: 'completed',
  });
  assert.deepEqual(trimmed.stepHistoryTotals, TALLIES, 'the durable entry carries the tallies');

  const plain = runtime._rememberRun({
    id: 'run-plain', goal: 'g', objective: 'o', steps: [{ action: 'a' }],
    queuedSteps: [], evidence: [], notes: [], status: 'completed',
  });
  assert.equal(Object.prototype.hasOwnProperty.call(plain, 'stepHistoryTotals'), false,
    'a run that was never trimmed keeps the pre-#3618 shape');
});

function runRuntime(overrides = {}) {
  return {
    fail: (type, reason, message, evidence, meta, state) => ({ ok: false, type, reason, message, meta, state }),
    ok: (type, state, evidence, meta) => ({ ok: true, type, data: state, meta }),
    plan: (goal, opts) => ({ ok: true, data: { goal, objective: opts.objective || '', selectedTools: [], steps: [], maxSteps: 3 } }),
    findResumeRun: () => null,
    emit: () => ({}),
    resetMemoryPersistence: () => {},
    rememberRun: () => {},
    executeStepWithRetry: step => ({ action: step.action, tool: step.tool, status: 'done', summary: 'ok', result: { ok: true } }),
    extractAgentSummary: () => ({ text: 'done' }),
    buildRunRecommendations: () => [],
    suggestNextAction: () => null,
    renderReport: () => 'report',
    memoryInfo: () => ({}),
    setLastRun: () => {},
    chooseFollowUp: () => null,
    findRecentFailure: () => false,
    stepSignature: () => 'sig',
    collectEvidence: () => [],
    updateToolStats: () => {},
    isStalledProgress: () => false,
    allowedTools: new Set(['ask']),
    kernel: {},
    agent: 'agent-v1',
    ...overrides,
  };
}

test('a resumed V1 run re-attaches the tallies, so the true step count is not reset to the held tail', () => {
  const resumeCandidate = {
    id: 'run-resumed',
    plan: { goal: 'g', objective: 'o', selectedTools: [], steps: [], maxSteps: 3 },
    steps: stepsWithTallies(),
    evidence: [], notes: [], queuedSteps: [],
    stepHistoryTotals: TALLIES,
  };
  const result = executeAgentRun({
    goal: 'g',
    opts: { resume: true, maxSteps: 3 },
    runtime: runRuntime({ findResumeRun: () => resumeCandidate }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.resumed, true);
  assert.equal(result.data.completedSteps, 41, 'held 1 + dropped 40, not the held tail');
  assert.deepEqual(summarizeStepHistory(result.data.steps).statuses, { done: 39, blocked: 2 });
});

test('a fresh V1 run starts with an empty, unbounded history', () => {
  const result = executeAgentRun({
    goal: 'g',
    opts: { resume: false, maxSteps: 3 },
    runtime: runRuntime(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.resumed, false);
  assert.equal(result.data.completedSteps, 0);
  assert.equal(result.data.steps.stepHistoryTotals, undefined);
});

test('a resumed V1 run whose candidate carries no tallies stays exactly as before', () => {
  const resumeCandidate = {
    id: 'run-resumed-plain',
    plan: { goal: 'g', objective: 'o', selectedTools: [], steps: [], maxSteps: 3 },
    steps: [{ action: 'a', status: 'done' }],
    evidence: [], notes: [], queuedSteps: [],
  };
  const result = executeAgentRun({
    goal: 'g',
    opts: { resume: true, maxSteps: 3 },
    runtime: runRuntime({ findResumeRun: () => resumeCandidate }),
  });
  assert.equal(result.data.resumed, true);
  assert.equal(result.data.steps.stepHistoryTotals, undefined);
  assert.equal(result.data.completedSteps, 1);
});
