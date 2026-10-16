'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  recordStepReport,
  advanceProgress,
  shouldForceDream,
  queueFollowUp,
} = require('../lib/agent-step-progression');

const RATIONALES = { fallback: 'fallback-text', followUp: 'follow-up-text' };

function fakeRuntime({ failing = [] } = {}) {
  const calls = [];
  return {
    calls,
    collectEvidence: results => results.map(result => ({ from: result.tag })),
    updateToolStats: (tool, status) => calls.push(['stats', tool, status]),
    extractAgentSummary: result => ({ text: result?.text || '' }),
    isStalledProgress: (previous, current) => Boolean(previous) && previous === String(current).toLowerCase(),
    stepSignature: step => `${step.tool}:${JSON.stringify(step.input || {})}`,
    findRecentFailure: signature => failing.includes(signature),
  };
}

function freshState() {
  return { steps: [], evidence: [], notes: [], progress: { stalledCount: 0, lastSummary: '' } };
}

test('recordStepReport records the step, its evidence, tool stats and a note', () => {
  const runtime = fakeRuntime();
  const state = freshState();
  const report = { action: 'search', tool: 'search', status: 'ok', summary: 's', result: { tag: 'r1' } };
  recordStepReport(runtime, state, report);
  assert.deepEqual(state.steps, [report]);
  assert.deepEqual(state.evidence, [{ from: 'r1' }]);
  assert.deepEqual(state.notes, [{ step: 'search', summary: 's' }]);
  assert.deepEqual(runtime.calls, [['stats', 'search', 'ok']]);
});

test('advanceProgress counts repeated summaries and resets on new ones', () => {
  const runtime = fakeRuntime();
  const state = freshState();
  advanceProgress(runtime, state, { result: { text: 'Same  Thing' } });
  assert.deepEqual(state.progress, { stalledCount: 0, lastSummary: 'same thing' });
  advanceProgress(runtime, state, { result: { text: 'same thing' } });
  advanceProgress(runtime, state, { result: { text: 'same thing' } });
  assert.equal(state.progress.stalledCount, 2);
  const summary = advanceProgress(runtime, state, { result: { text: 'new' } });
  assert.deepEqual(summary, { text: 'new' });
  assert.deepEqual(state.progress, { stalledCount: 0, lastSummary: 'new' });
});

test('shouldForceDream needs two stalls, step budget and no queued dream', () => {
  const state = { ...freshState(), steps: [{}], progress: { stalledCount: 2 } };
  assert.equal(shouldForceDream(state, [], 5), true);
  assert.equal(shouldForceDream({ ...state, progress: { stalledCount: 1 } }, [], 5), false);
  assert.equal(shouldForceDream(state, [], 1), false);
  assert.equal(shouldForceDream(state, [{ tool: 'dream' }], 5), false);
});

test('a forced dream wins over any follow-up', () => {
  const queued = [];
  queueFollowUp({ runtime: fakeRuntime(), state: { steps: [{}] }, queued, maxSteps: 5, forceDream: true, followUp: { action: 'x', tool: 'x', input: {} }, rationales: RATIONALES });
  assert.deepEqual(queued, [{ id: 'dream-2', action: 'dream', tool: 'dream', input: {}, rationale: 'Progress stalled; switching to hypothesis mode.' }]);
});

test('a follow-up is queued with the caller rationale', () => {
  const queued = [{ id: 'later' }];
  queueFollowUp({ runtime: fakeRuntime(), state: { steps: [{}, {}] }, queued, maxSteps: 5, forceDream: false, followUp: { action: 'read', tool: 'read', input: { a: 1 }, rationale: 'ignored' }, rationales: RATIONALES });
  assert.deepEqual(queued[0], { id: 'read-3', action: 'read', tool: 'read', input: { a: 1 }, rationale: 'follow-up-text' });
  assert.equal(queued.length, 2);
});

test('a follow-up that failed recently is replaced by a dream fallback', () => {
  const queued = [];
  const runtime = fakeRuntime({ failing: ['read:{}'] });
  queueFollowUp({ runtime, state: { steps: [{}] }, queued, maxSteps: 5, forceDream: false, followUp: { action: 'read', tool: 'read', input: {} }, rationales: RATIONALES });
  assert.deepEqual(queued, [{ id: 'dream-2', action: 'dream', tool: 'dream', input: {}, rationale: 'fallback-text' }]);
});

test('no fallback when the failing follow-up is a dream or the dream also failed', () => {
  const runtime = fakeRuntime({ failing: ['dream:{}', 'read:{}'] });
  for (const followUp of [{ action: 'dream', tool: 'dream', input: {} }, { action: 'read', tool: 'read', input: {} }]) {
    const queued = [];
    queueFollowUp({ runtime, state: { steps: [{}] }, queued, maxSteps: 5, forceDream: false, followUp, rationales: RATIONALES });
    assert.deepEqual(queued, [], followUp.action);
  }
});

test('nothing is queued without a follow-up or once the step budget is spent', () => {
  const queued = [];
  queueFollowUp({ runtime: fakeRuntime(), state: { steps: [{}] }, queued, maxSteps: 5, forceDream: false, followUp: null, rationales: RATIONALES });
  queueFollowUp({ runtime: fakeRuntime(), state: { steps: [{}, {}] }, queued, maxSteps: 2, forceDream: false, followUp: { action: 'read', tool: 'read', input: {} }, rationales: RATIONALES });
  assert.deepEqual(queued, []);
});
