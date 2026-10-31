'use strict';

// COG-M4 (#4070, PR-1): pure, deterministic retention scoring for the
// reversible-forgetting selector. Importance is the gate; unknown is not small.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  retentionScore, rankForgetCandidates, FORGET_THRESHOLD, REPLAY_PROTECT_FLOOR, MAX_LIMIT,
} = require('../lib/cognition/forgetting-score');

const memory = (memoryId, extra = {}) => ({
  memoryId, status: 'active', kind: 'fact',
  importance: 0.2, importanceSource: 'declared-task-criticality',
  recency: 0.12, uses: undefined, createdAt: '2026-01-01T00:00:00Z',
  pinned: false, dependencyProtected: false,
  ...extra,
});

test('unknown importance always yields eligible false even with recency 0.01', () => {
  for (const record of [memory('m_1', { importance: undefined }), memory('m_2', { importanceSource: undefined })]) {
    const score = retentionScore(record);
    assert.equal(score.status, 'ABSTAIN');
    assert.equal(score.reason, 'importance_unknown');
    assert.equal(score.retention, null);
    assert.equal(score.eligible, false);
    assert.equal(score.authority, 'SIGNAL_ONLY');
  }
  // recency 0.01 is far below the threshold, yet unknown importance still abstains.
  assert.equal(retentionScore(memory('m_3', { importance: undefined, recency: 0.01 })).status, 'ABSTAIN');
});

test('missing importance provenance and dependency view prevent archive eligibility', () => {
  const noSource = retentionScore(memory('m_1', { importanceSource: '  ' }));
  assert.equal(noSource.status, 'ABSTAIN');
  assert.equal(noSource.eligible, false);

  const noDependencyView = retentionScore(memory('m_2', { dependencyProtected: undefined }));
  assert.equal(noDependencyView.status, 'MEASURED');
  assert.equal(noDependencyView.eligible, false);
  assert.equal(noDependencyView.reason, 'dependency_view_unknown');
});

test('unknown usage applies no discount while known importance and age remain explicit', () => {
  const score = retentionScore(memory('m_1', { importance: 0.5, recency: 0.5, uses: undefined }));
  assert.equal(score.status, 'MEASURED');
  assert.deepEqual(score.unknownComponents, ['uses']);
  assert.equal(score.components.usage, 1);
  assert.equal(score.retention, 0.25);
  // A zero-usage reading would collapse retention to 0; the factor is 1, not 0.
  assert.ok(score.retention > 0);
  assert.equal(score.eligible, false); // 0.25 >= FORGET_THRESHOLD
  assert.equal(score.reason, 'retention_above_threshold');
});

test('known usage follows the retrieval-practice curve', () => {
  const score = retentionScore(memory('m_1', { importance: 1, recency: 1, uses: 2 }));
  assert.deepEqual(score.unknownComponents, []);
  assert.equal(score.components.usage, 0.6);
  assert.equal(score.retention, 0.6);
});

test('confidence and absolute valence cannot silently stand in for importance', () => {
  const viaConfidence = retentionScore(memory('m_1', { importance: undefined, provenance: { confidence: 0.1 } }));
  const viaValence = retentionScore(memory('m_2', { importance: undefined, valence: -0.9 }));
  for (const score of [viaConfidence, viaValence]) {
    assert.equal(score.status, 'ABSTAIN');
    assert.equal(score.eligible, false);
    assert.equal(score.retention, null);
  }
});

test('open-task and indispensable evidence dependencies are protected', () => {
  const score = retentionScore(memory('m_1', { dependencyProtected: true, importance: 0.05, recency: 0.05, uses: 0 }));
  assert.equal(score.status, 'MEASURED');
  assert.equal(score.eligible, false);
  assert.equal(score.reason, 'dependency_protected');
});

test('never selects policy or capability kinds', () => {
  for (const kind of ['policy', 'capability']) {
    const score = retentionScore(memory('m_1', { kind, importance: 0.05, recency: 0.05, uses: 0 }));
    assert.equal(score.eligible, false);
    assert.equal(score.reason, 'protected_kind');
  }
});

test('replay protection floors retention', () => {
  const score = retentionScore(memory('m_1', { importance: 0.1, recency: 0.1, uses: 0, replayedWithinDays: 5 }));
  assert.equal(score.retention, REPLAY_PROTECT_FLOOR);
  assert.equal(score.eligible, false); // floored above the threshold
  const stale = retentionScore(memory('m_2', { importance: 0.1, recency: 0.1, uses: 0, replayedWithinDays: 90 }));
  assert.ok(stale.retention < FORGET_THRESHOLD);
  assert.equal(stale.eligible, true);
});

test('orders by retention then createdAt then memoryId', () => {
  const records = [
    memory('m_b', { importance: 0.2, recency: 0.12, uses: undefined, createdAt: '2026-02-01T00:00:00Z' }),
    memory('m_a', { importance: 0.2, recency: 0.12, uses: undefined, createdAt: '2026-02-01T00:00:00Z' }),
    memory('m_newer', { importance: 0.2, recency: 0.12, uses: undefined, createdAt: '2026-03-01T00:00:00Z' }),
    memory('m_low', { importance: 0.1, recency: 0.1, uses: 0, createdAt: '2026-03-01T00:00:00Z' }),
  ];
  const result = rankForgetCandidates(records);
  assert.equal(result.status, 'MEASURED');
  assert.deepEqual(result.candidates.map((row) => row.memoryId), ['m_low', 'm_a', 'm_b', 'm_newer']);
  assert.deepEqual(result, rankForgetCandidates([...records].reverse()));
});

test('respects MAX_LIMIT and rejects an out-of-range limit', () => {
  const records = Array.from({ length: 5 }, (_, i) => memory(`m_${i}`, { importance: 0.1, recency: 0.1, uses: 0 }));
  assert.equal(rankForgetCandidates(records, { limit: 2 }).candidates.length, 2);
  assert.equal(rankForgetCandidates(records, { limit: MAX_LIMIT + 1 }).reason, 'invalid_limit');
  assert.equal(rankForgetCandidates(records, { limit: -1 }).reason, 'invalid_limit');
  assert.equal(rankForgetCandidates(records, { x: 1 }).reason, 'invalid_options');
});

test('rejects malformed input and abstains with no eligible candidates', () => {
  assert.equal(retentionScore(null).status, 'REJECT');
  assert.equal(retentionScore({ status: 'active' }).status, 'REJECT');
  assert.equal(rankForgetCandidates('x').status, 'REJECT');
  const none = rankForgetCandidates([memory('m_1', { importance: 0.9, recency: 0.9, uses: 5 })]);
  assert.equal(none.status, 'INSUFFICIENT');
  assert.deepEqual(none.candidates, []);
  assert.equal(none.skipped[0].reason, 'retention_above_threshold');
});

test('does not mutate its input and returns frozen results', () => {
  const record = memory('m_1');
  const snapshot = JSON.stringify(record);
  const score = retentionScore(record);
  assert.ok(Object.isFrozen(score));
  assert.equal(JSON.stringify(record), snapshot);
  const result = rankForgetCandidates([record]);
  assert.ok(Object.isFrozen(result));
  assert.equal(JSON.stringify(record), snapshot);
});
