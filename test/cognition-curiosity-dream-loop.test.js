'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createInitialState, startFromDreamResult, extractHypotheses,
} = require('../lib/dream-experiment-loop');
const { selectHypotheses, MAX_HYPOTHESES } = require('../lib/dream-experiment-loop-hypotheses');
const { rankHypothesesByCuriosity } = require('../lib/cognition/curiosity');
const { processDreamStep } = require('../lib/agent-v3-dream-loop-adapter');

function fakeKernel() {
  const journal = new Map();
  const audits = [];
  return {
    graph: {
      runMutationOnce(operationId, mutate) {
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
    commitBackgroundEdge() {
      return { decision: 'allow', edge: null, admission: { outcome: 'allow' } };
    },
    _test: { audits },
  };
}

const record = (region, predictorVersion, error, at) => ({
  region, probeSetId: 'probe-set-1', predictorVersion, frameRef: 'frame-1',
  at, errors: [error, error, error, error], verificationSourceRefs: ['verify:run-1'],
  coverage: 1, sourceGroup: 'monitor-a',
});
const history = () => [
  record('yapabilir', 'p1', 0.8, '2026-10-20T00:00:00.000Z'),
  record('yapabilir', 'p2', 0.2, '2026-10-21T00:00:00.000Z'),
  record('zincir', 'p1', 0.5, '2026-10-20T00:00:00.000Z'),
  record('zincir', 'p2', 0.5, '2026-10-21T00:00:00.000Z'),
];
const hypothesis = (index, region, confidence) => ({
  from: `düğüm-${index}`, to: `hedef-${index}`, relation: 'hipotez', region, confidence,
});
const flatPool = (count = 11) => Array.from({ length: count }, (_, index) => hypothesis(index, 'zincir', 0.95 - index * 0.01));
const falling = () => hypothesis(99, 'yapabilir', 0.1);

test('the ranker runs before both the MAX_HYPOTHESES and maxHypotheses cuts', () => {
  const pool = [...flatPool(), falling()];
  const legacy = extractHypotheses(pool);
  assert.equal(legacy.length, MAX_HYPOTHESES);
  assert.equal(legacy.some(item => item.region === 'yapabilir'), false, 'the low-confidence candidate is beyond the old cut');

  const selected = selectHypotheses(pool, {
    rankHypotheses: rankHypothesesByCuriosity, history: history(), maxHypotheses: 2,
  });
  assert.equal(selected.hypotheses.length, 2);
  assert.equal(selected.hypotheses[0].region, 'yapabilir');
  assert.equal(selected.curiosity.status, 'MEASURED');
  assert.equal(selected.curiosity.pooled, 12);
  assert.equal(selected.curiosity.truncated, false);
});

test('a low-confidence high-curiosity candidate reaches the selected set through the loop', () => {
  const kernel = fakeKernel();
  const state = createInitialState({ workspaceId: 'ws', goal: 'test', maxHypotheses: 2 });
  const result = startFromDreamResult(kernel, state, [...flatPool(), falling()], {
    workspaceId: 'ws', goal: 'test',
    rankHypotheses: rankHypothesesByCuriosity, history: history(),
  });
  assert.equal(result.state.hypotheses.length, 2);
  const selected = result.state.hypotheses[0];
  assert.equal(selected.region, 'yapabilir');
  assert.deepEqual(selected.curiosity, {
    curiosity: 1, learningProgress: 0.6, learningProgressStatus: 'MEASURED',
    explorationBonus: 0.011111, noiseGuard: false, score: 0.55,
  });
  assert.equal(result.state.curiosity.status, 'MEASURED');
  assert.equal(result.nextStep.tool, 'verify');
  assert.equal(result.nextStep.input, selected.claim);
});

test('without the flag the hypothesis order is the legacy confidence order', () => {
  const pool = [...flatPool(4), falling()];
  const kernel = fakeKernel();
  const state = createInitialState({ workspaceId: 'ws', goal: 'test', maxHypotheses: 3 });
  const result = startFromDreamResult(kernel, state, pool, { workspaceId: 'ws', goal: 'test' });
  const legacy = extractHypotheses(pool).slice(0, 3);
  assert.deepEqual(result.state.hypotheses.map(item => item.key), legacy.map(item => item.key));
  assert.equal(result.state.curiosity, null);
  for (const item of result.state.hypotheses) assert.equal(item.curiosity, undefined);
});

test('a ranker that adds a candidate is rejected and the confidence order is kept', () => {
  const ghost = (pool) => ({
    status: 'MEASURED',
    ranked: [...pool.map(item => ({ key: item.key, score: 0.5 })), { key: 'ghost', score: 1 }],
  });
  const pool = [...flatPool(3), falling()];
  const selected = selectHypotheses(pool, { rankHypotheses: ghost, maxHypotheses: 2 });
  assert.equal(selected.curiosity.status, 'REJECT');
  assert.equal(selected.curiosity.reason, 'ranker_changed_candidate_set');
  assert.deepEqual(selected.hypotheses.map(item => item.key),
    extractHypotheses(pool).slice(0, 2).map(item => item.key));
  assert.ok(!selected.hypotheses.some(item => item.key === 'ghost'));
});

test('an abstaining ranker falls back to the confidence order visibly', () => {
  const abstain = (pool) => ({ status: 'ABSTAIN', reason: 'invalid_history', ranked: pool.map(item => ({ key: item.key, score: 0 })) });
  const pool = [...flatPool(3), falling()];
  const selected = selectHypotheses(pool, { rankHypotheses: abstain, maxHypotheses: 2 });
  assert.equal(selected.curiosity.status, 'ABSTAIN');
  assert.equal(selected.curiosity.reason, 'invalid_history');
  assert.equal(selected.hypotheses.length, 2);
  assert.ok(!selected.hypotheses.some(item => item.region === 'yapabilir'));
});

test('the adapter injects the ranker only behind the flag and leaves transitions unchanged', () => {
  const pool = [...flatPool(), falling()];
  const run = (options) => {
    const kernel = fakeKernel();
    const state = createInitialState({ workspaceId: 'ws', goal: 'test', maxHypotheses: 2 });
    const result = processDreamStep(kernel, state, { step: { tool: 'dream' }, report: { result: pool } }, {
      workspaceId: 'ws', goal: 'test', ...options,
    });
    return { result, audits: kernel._test.audits };
  };
  const flagged = run({ curiosity: true, curiosityHistory: history() });
  const legacy = run({});
  assert.equal(flagged.result.nextStep.id, legacy.result.nextStep.id);
  assert.deepEqual(Object.keys(flagged.audits), Object.keys(legacy.audits));
  const shape = ({ details, ...rest }) => {
    const { hypothesisKey, ...stable } = details;
    assert.equal(typeof hypothesisKey, 'string');
    return { ...rest, details: stable };
  };
  assert.deepEqual(flagged.audits.map(shape), legacy.audits.map(shape));
  assert.equal(flagged.result.state.hypotheses[0].region, 'yapabilir');
  assert.equal(legacy.result.state.hypotheses[0].region, 'zincir');
});

test('the curiosity annotation never invents probability or information gain', () => {
  const selected = selectHypotheses([...flatPool(2), falling()], {
    rankHypotheses: rankHypothesesByCuriosity, history: history(), maxHypotheses: 2,
  });
  const fields = Object.keys(selected.hypotheses[0].curiosity);
  for (const forbidden of ['probability', 'surpriseBits', 'informationGain']) {
    assert.ok(!fields.includes(forbidden));
  }
});
