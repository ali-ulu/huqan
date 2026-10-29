'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SCHEMA_VERSION, LP_WINDOW, LP_SCALE, LP_MIN, EXPLORATION_BONUS, NOISE_VARIANCE_MAX,
  W_CURIOSITY, W_CONFIDENCE, learningProgress, rankHypothesesByCuriosity,
} = require('../lib/cognition/curiosity');

const record = (region, predictorVersion, errors, extra = {}) => ({
  region, probeSetId: 'probe-set-1', predictorVersion, frameRef: 'frame-1',
  at: '2026-10-20T00:00:00.000Z', errors,
  verificationSourceRefs: ['verify:run-1'], coverage: 1, sourceGroup: 'monitor-a', ...extra,
});

// One frozen window of LP_WINDOW errors; two windows with different predictor
// versions are what make a comparison eligible.
const window = (region, predictorVersion, error, extra = {}) =>
  [record(region, predictorVersion, [error, error, error, error], extra)];

const history = () => [
  ...window('yapabilir', 'p1', 0.8),
  ...window('yapabilir', 'p2', 0.2, { at: '2026-10-21T00:00:00.000Z' }),
  ...window('zincir', 'p1', 0.5),
  ...window('zincir', 'p2', 0.5, { at: '2026-10-21T00:00:00.000Z' }),
];

const hyp = (key, region, confidence) => ({ key, region, confidence });
const keysOf = (value) => {
  if (value === null || typeof value !== 'object') return [];
  return Object.keys(value).flatMap((key) => [key, ...keysOf(value[key])]);
};

test('ranks by the locked formula with signal-only authority and no learning claim fields', () => {
  const result = rankHypothesesByCuriosity(
    [hyp('flat', 'zincir', 0.9), hyp('falling', 'yapabilir', 0.2)],
    { history: history() },
  );
  assert.equal(result.schemaVersion, SCHEMA_VERSION);
  assert.equal(result.status, 'MEASURED');
  assert.equal(result.authority, 'SIGNAL_ONLY');
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(result.ranked.map((row) => row.key), ['falling', 'flat']);
  const falling = result.ranked[0];
  assert.deepEqual(falling, {
    key: 'falling', region: 'yapabilir', curiosity: 1, learningProgress: 0.6,
    learningProgressStatus: 'MEASURED', explorationBonus: 0.011111, noiseGuard: false, score: 0.6,
  });
  assert.equal(falling.score, W_CURIOSITY * falling.curiosity + W_CONFIDENCE * 0.2);
  const allKeys = keysOf(result);
  for (const forbidden of ['probability', 'surpriseBits', 'informationGain']) {
    assert.ok(!allKeys.includes(forbidden), `${forbidden} must never be derived from uncalibrated confidence`);
  }
  assert.deepEqual(learningProgress(history(), { region: 'yapabilir' }), {
    schemaVersion: SCHEMA_VERSION, status: 'MEASURED', region: 'yapabilir',
    learningProgress: 0.6, variance: 0, noiseGuard: false, observations: 8,
    probeSetId: 'probe-set-1', frameRef: 'frame-1', predictorVersions: ['p1', 'p2'],
    reason: 'learning_progress_measured', authority: 'SIGNAL_ONLY',
  });
});

test('prefers the region whose error is falling over the region with flat error', () => {
  const result = rankHypothesesByCuriosity([hyp('flat', 'zincir', 0.95), hyp('falling', 'yapabilir', 0.1)], { history: history() });
  assert.equal(result.ranked[0].key, 'falling');
  assert.equal(result.ranked[0].learningProgress, 0.6);
  assert.equal(result.ranked[1].learningProgress, 0);
  assert.ok(result.ranked[1].curiosity < result.ranked[0].curiosity);
});

test('noise guard zeroes curiosity for high-variance flat regions', () => {
  const noisy = [
    ...window('zincir', 'p1', 0.5),
    record('zincir', 'p2', [1, 0, 1, 0], { at: '2026-10-21T00:00:00.000Z' }),
  ];
  const result = rankHypothesesByCuriosity([hyp('noisy', 'zincir', 0.9)], { history: noisy });
  const row = result.ranked[0];
  assert.equal(row.learningProgress, 0);
  assert.equal(row.noiseGuard, true);
  assert.equal(row.curiosity, 0);
  assert.equal(row.score, W_CONFIDENCE * 0.9);
  assert.equal(learningProgress(noisy, { region: 'zincir' }).reason, 'no_learning_progress');
});

test('exploration bonus decays with sample count', () => {
  const few = rankHypothesesByCuriosity([hyp('h', 'yapabilir', 0.5)], { history: [record('yapabilir', 'p1', [0.5])] });
  const many = rankHypothesesByCuriosity([hyp('h', 'yapabilir', 0.5)], { history: history() });
  assert.equal(few.ranked[0].explorationBonus, EXPLORATION_BONUS / 2);
  assert.equal(many.ranked[0].explorationBonus, Number((EXPLORATION_BONUS / 9).toFixed(6)));
  assert.ok(many.ranked[0].explorationBonus < few.ranked[0].explorationBonus);
});

test('same predictor on an easier task mix does not report learning progress', () => {
  const easier = [...window('yapabilir', 'p1', 0.8), ...window('yapabilir', 'p1', 0.2, { at: '2026-10-21T00:00:00.000Z' })];
  const result = rankHypothesesByCuriosity([hyp('h', 'yapabilir', 0.5)], { history: easier });
  assert.equal(result.status, 'INSUFFICIENT');
  assert.equal(result.ranked[0].learningProgress, null);
  assert.equal(result.ranked[0].learningProgressStatus, 'INSUFFICIENT');
  assert.equal(result.ranked[0].curiosity, Number((EXPLORATION_BONUS / 9).toFixed(6)));
  assert.equal(learningProgress(easier, { region: 'yapabilir' }).reason, 'predictor_unchanged');
});

test('rising error never produces a negative learning progress', () => {
  const worse = [...window('yapabilir', 'p1', 0.2), ...window('yapabilir', 'p2', 0.8, { at: '2026-10-21T00:00:00.000Z' })];
  const summary = learningProgress(worse, { region: 'yapabilir' });
  assert.equal(summary.status, 'MEASURED');
  assert.equal(summary.learningProgress, 0);
});

test('abstains on non-finite history instead of repairing it', () => {
  const corrupt = [record('yapabilir', 'p1', [0.5, Number.POSITIVE_INFINITY])];
  const result = rankHypothesesByCuriosity([hyp('h', 'yapabilir', 0.5)], { history: corrupt });
  assert.equal(result.status, 'ABSTAIN');
  assert.equal(result.reason, 'invalid_history');
  assert.deepEqual(result.ranked, []);
  assert.equal(learningProgress(corrupt, { region: 'yapabilir' }).status, 'ABSTAIN');
  assert.equal(learningProgress([record('yapabilir', 'p1', [0.5], { at: 'not-a-date' })], { region: 'yapabilir' }).status, 'ABSTAIN');
});

test('rejects source-group overlap between monitoring probes and final holdout', () => {
  const leaked = history().map((row) => ({ ...row, sourceGroup: 'holdout-g1' }));
  const result = rankHypothesesByCuriosity([hyp('h', 'yapabilir', 0.5)], {
    history: leaked, finalHoldoutSourceGroups: ['holdout-g1'],
  });
  assert.equal(result.status, 'REJECT');
  assert.equal(result.reason, 'source_group_overlap');
  assert.deepEqual(result.ranked, []);
});

test('final holdout labels and results never enter the ranking', () => {
  const tainted = history().map((row) => ({ ...row, holdoutLabel: 'y', finalHoldoutResult: 1 }));
  assert.deepEqual(
    rankHypothesesByCuriosity([hyp('h', 'yapabilir', 0.5)], { history: tainted }),
    rankHypothesesByCuriosity([hyp('h', 'yapabilir', 0.5)], { history: history() }),
  );
});

test('unknown legacy records abstain instead of joining a comparison', () => {
  const legacy = [{ region: 'yapabilir', errors: [0.9, 0.9, 0.9, 0.9] }, { errors: [0.1, 0.1, 0.1, 0.1] }];
  const summary = learningProgress(legacy, { region: 'yapabilir' });
  assert.equal(summary.status, 'INSUFFICIENT');
  assert.equal(summary.learningProgress, null);
  assert.equal(summary.reason, 'insufficient_comparable_windows');
  const result = rankHypothesesByCuriosity([hyp('h', 'yapabilir', 0.5)], { history: legacy });
  assert.equal(result.status, 'INSUFFICIENT');
  assert.equal(result.ranked.length, 1);
});

test('ranking is deterministic, order-independent and never adds or drops a candidate', () => {
  const hypotheses = [hyp('b', 'zincir', 0.4), hyp('a', 'yapabilir', 0.4), hyp('c', null, 0.4)];
  const forward = rankHypothesesByCuriosity(hypotheses, { history: history() });
  const backward = rankHypothesesByCuriosity([...hypotheses].reverse(), { history: [...history()].reverse() });
  assert.deepEqual(forward, backward);
  assert.deepEqual(forward.ranked.map((row) => row.key), ['a', 'c', 'b']);
  assert.equal(forward.ranked.filter((row) => row.key === 'c')[0].region, null);
  assert.equal(forward.ranked.filter((row) => row.key === 'c')[0].learningProgressStatus, 'INSUFFICIENT');
});

test('rejects malformed input instead of guessing', () => {
  assert.equal(rankHypothesesByCuriosity(null, { history: [] }).reason, 'invalid_hypotheses');
  assert.equal(rankHypothesesByCuriosity([{ region: 'yapabilir' }], { history: [] }).reason, 'invalid_hypothesis');
  assert.equal(rankHypothesesByCuriosity([hyp('a', 'yapabilir', 0.5), hyp('a', 'zincir', 0.5)], { history: [] }).reason, 'duplicate_key');
  assert.equal(rankHypothesesByCuriosity([hyp('a', 'yapabilir', 0.5)], { history: [], unknown: 1 }).reason, 'invalid_options');
  assert.equal(rankHypothesesByCuriosity([hyp('a', 'yapabilir', 0.5)], { finalHoldoutSourceGroups: ['x', 3] }).reason, 'invalid_options');
  assert.equal(learningProgress([], { region: '' }).status, 'REJECT');
});

test('empty candidate set is insufficient, not a silent success', () => {
  const result = rankHypothesesByCuriosity([], { history: history() });
  assert.equal(result.status, 'INSUFFICIENT');
  assert.equal(result.reason, 'no_hypotheses');
  assert.deepEqual(result.ranked, []);
});

test('constants are the frozen design starting points from #4071', () => {
  assert.deepEqual({
    LP_WINDOW, LP_SCALE, LP_MIN, EXPLORATION_BONUS, NOISE_VARIANCE_MAX, W_CURIOSITY, W_CONFIDENCE,
  }, {
    LP_WINDOW: 4, LP_SCALE: 2, LP_MIN: 0.02, EXPLORATION_BONUS: 0.1,
    NOISE_VARIANCE_MAX: 0.2, W_CURIOSITY: 0.5, W_CONFIDENCE: 0.5,
  });
});
