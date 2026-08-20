'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createInitialState,
  startFromDreamResult,
  advanceAfterVerification,
  loopEnabled,
} = require('../lib/dream-experiment-loop');

function fakeKernel({ durable = true, edgeDecision = 'allow' } = {}) {
  const journal = new Map();
  const audits = [];
  const edges = [];
  const kernel = {
    graph: {
      runMutationOnce(operationId, mutate) {
        if (!durable) throw new Error('durability unavailable');
        if (journal.has(operationId)) return { replayed: true, result: journal.get(operationId) };
        const result = mutate();
        journal.set(operationId, result);
        return { replayed: false, result, persisted: true };
      },
      appendAuditEvent(event) {
        const normalized = { auditId: `audit-${audits.length + 1}`, ...event };
        audits.push(normalized);
        return normalized;
      },
    },
    _commitBackgroundEdge(from, to, relation, source, opts) {
      const result = {
        decision: edgeDecision,
        edge: edgeDecision === 'allow' ? { from, to, relation, source, workspaceId: opts.workspaceId } : null,
        admission: { outcome: edgeDecision },
      };
      edges.push({ from, to, relation, source, opts, result });
      return result;
    },
    _test: { audits, edges },
  };
  return kernel;
}

test('Dream loop persists bounded generation and advances to the first verification step', () => {
  const kernel = fakeKernel();
  const initial = createInitialState({ workspaceId: 'ws-dream', goal: 'test', maxHypotheses: 2, maxCycles: 1 });
  const result = startFromDreamResult(kernel, initial, [
    { from: 'kedi', to: 'hayvan', relation: 'tür', confidence: 0.91 },
    { from: 'kedi', to: 'evcil', relation: 'özellik', confidence: 0.7 },
  ], { workspaceId: 'ws-dream', goal: 'test' });

  assert.equal(result.blocked, false);
  assert.equal(result.state.status, 'running');
  assert.equal(result.state.hypotheses.length, 2);
  assert.equal(result.nextStep.tool, 'verify');
  assert.equal(result.nextStep.action, 'dream-experiment-verify');
  assert.equal(result.state.transitionSeq, 1);
  assert.equal(kernel._test.audits.length, 1);
  assert.equal(kernel._test.audits[0].targetType, 'dream_experiment');
});

test('Verified observation commits through background admission and selects the next bounded hypothesis', () => {
  const kernel = fakeKernel();
  const initial = createInitialState({ workspaceId: 'ws-dream', goal: 'test', maxHypotheses: 2, maxCycles: 1 });
  const generated = startFromDreamResult(kernel, initial, [
    { from: 'kedi', to: 'hayvan', relation: 'tür', confidence: 0.91 },
    { from: 'kedi', to: 'evcil', relation: 'özellik', confidence: 0.7 },
  ], { workspaceId: 'ws-dream', goal: 'test' });

  const observed = advanceAfterVerification(kernel, generated.state, {
    step: generated.nextStep,
    status: 'done',
    result: {
      ok: true,
      data: { status: 'verified', confidence: 0.88 },
      evidence: [{ kind: 'edge' }],
    },
  }, { workspaceId: 'ws-dream', goal: 'test' });

  assert.equal(observed.blocked, false);
  assert.equal(observed.state.observations[0].signal, 'support');
  assert.equal(observed.state.observations[0].commitDecision, 'allow');
  assert.equal(kernel._test.edges.length, 1);
  assert.equal(kernel._test.edges[0].relation, 'tür');
  assert.equal(observed.nextStep.tool, 'verify');
  assert.equal(observed.nextStep.dreamExperiment.hypothesisKey, generated.state.hypotheses[1].key);
});

test('Non-supporting observation does not create a canonical edge and ends a bounded one-hypothesis cycle', () => {
  const kernel = fakeKernel();
  const initial = createInitialState({ workspaceId: 'ws-dream', goal: 'test', maxHypotheses: 1, maxCycles: 1 });
  const generated = startFromDreamResult(kernel, initial, [
    { from: 'x', to: 'y', relation: 'hipotez', confidence: 0.6 },
  ], { workspaceId: 'ws-dream', goal: 'test' });

  const observed = advanceAfterVerification(kernel, generated.state, {
    step: generated.nextStep,
    result: {
      ok: true,
      data: { status: 'unknown', confidence: 0 },
      evidence: [],
    },
  }, { workspaceId: 'ws-dream', goal: 'test' });

  assert.equal(observed.blocked, false);
  assert.equal(observed.state.status, 'completed');
  assert.equal(observed.state.nextAction, null);
  assert.equal(observed.state.observations[0].commitDecision, 'not_applicable');
  assert.equal(kernel._test.edges.length, 0);
});

test('Loop fails closed when Graph mutation durability is unavailable', () => {
  const kernel = fakeKernel({ durable: false });
  const initial = createInitialState({ workspaceId: 'ws-dream', goal: 'test' });
  const result = startFromDreamResult(kernel, initial, [
    { from: 'a', to: 'b', relation: 'hipotez', confidence: 0.8 },
  ], { workspaceId: 'ws-dream', goal: 'test' });

  assert.equal(result.blocked, true);
  assert.equal(result.state.status, 'blocked');
  assert.equal(result.state.nextAction, null);
  assert.match(result.state.lastError.message, /durability/i);
});

test('Loop is opt-in and requires the existing Graph mutation journal', () => {
  assert.equal(loopEnabled({ dreamExperimentLoop: true }, { graph: { runMutationOnce() {} } }), true);
  assert.equal(loopEnabled({}, { graph: { runMutationOnce() {} } }), false);
  assert.equal(loopEnabled({ dreamExperimentLoop: true }, { graph: {} }), false);
});
