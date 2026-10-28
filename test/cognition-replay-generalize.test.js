'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { groupForCandidates, groupForRecentCandidates, MIN_GROUP_SIZE, CONSISTENCY_MIN } = require('../lib/cognition/replay-generalize');

const options = { workspaceId: 'default', replayedAt: '2026-10-26T00:00:00Z' };
const episode = (id, reward = 1, extra = {}) => ({ episodeId: id, workspaceId: 'default', key: 'cap:stored-ab',
  frameTask: 'replace_text', at: '2026-10-25T00:00:00Z', predictionError: { status: 'MEASURED', magnitude: 0.5 },
  reward: { status: 'MEASURED', reward, rpe: reward }, sourceGroup: `group:${id}`, sourceRefs: [`source:${id}`], ...extra });

test('recent-K changes only selection order and breaks equal-time ties by episode ID', () => {
  const rows = [episode('old', 1, { at: '2026-10-24T00:00:00Z', predictionError: { magnitude: 1 } }),
    ...['c', 'b', 'a'].map(id => episode(id, 1, { predictionError: { magnitude: 0 }, reward: { reward: 1, rpe: 0 } }))];
  const opts = { ...options, budget: 3 };
  const priority = groupForCandidates(rows, opts), recent = groupForRecentCandidates(rows, opts);
  assert.deepEqual(priority.selected.map(row => row.episodeId), ['old', 'a', 'b']);
  assert.deepEqual(recent.selected.map(row => row.episodeId), ['a', 'b', 'c']);
  assert.deepEqual(recent.candidates[0].support, ['a', 'b', 'c']);
  assert.equal(recent.candidates[0].nIndependent, 3);
  assert.equal(recent.candidates[0].registered, false);
  assert.equal(recent.candidates[0].authority, 'CANDIDATE_ONLY');
  assert.deepEqual(recent, groupForRecentCandidates([...rows].reverse(), opts));
});

test('recent-K shares measured-signal eligibility, scope, replay cutoff and budget', () => {
  const rows = ['c', 'b', 'a'].map(id => episode(id));
  rows.push(episode('unknown', 1, { at: '2026-10-25T23:00:00Z', reward: { status: 'ABSTAIN', reward: null, rpe: null } }),
    episode('future', 1, { at: '2026-10-27T00:00:00Z' }),
    episode('foreign', 1, { workspaceId: 'other', extra: true }),
    episode('missing', 1, { reward: { rpe: 1 } }));
  const opts = { ...options, budget: 2 };
  const recent = groupForRecentCandidates(rows, opts);
  assert.deepEqual(recent.selected.map(row => row.episodeId), ['a', 'b']);
  assert.deepEqual(recent.skipped, groupForCandidates(rows, opts).skipped);
  assert.deepEqual(recent.skipped.map(row => row.episodeId), ['future', 'missing', 'unknown']);
  assert.equal(recent.candidates.length, 0);
  assert.equal(recent.budget, 2);
});

test('recent-K keeps unselected and abstained bridges in the full dependency universe', () => {
  const rows = ['a', 'b', 'c'].map(id => episode(id));
  const bridge = episode('bridge', 1, { at: '2026-10-24T00:00:00Z', sourceGroup: null,
    sourceRefs: ['source:a', 'source:b', 'source:c'], predictionError: { magnitude: 0 }, reward: { reward: 1, rpe: 0 } });
  const opts = { ...options, budget: 3 };
  for (const extra of [bridge, { ...bridge, predictionError: { status: 'ABSTAIN', magnitude: null } }]) {
    const recent = groupForRecentCandidates([...rows, extra], opts);
    assert.deepEqual(recent.selected.map(row => row.episodeId), ['a', 'b', 'c']);
    assert.equal(recent.candidates.length, 0);
  }
  for (const extra of [{ ...bridge, at: '2026-10-27T00:00:00Z' }, { ...bridge, workspaceId: 'other' }])
    assert.equal(groupForRecentCandidates([...rows, extra], opts).candidates[0].nIndependent, 3);
});

test('recent-K preserves priority validation and forbidden-artifact refusals', () => {
  for (const [rows, opts] of [[null, options], [[episode('a')], null],
    [[episode('a')], { ...options, budget: 0 }], [[episode('a')], { ...options, strategy: 'recent' }],
    [[episode('a'), episode('a')], options], [[episode('a', 1, { key: 'policy:scope' })], options],
    [[episode('a', 1, { unexpected: true })], options]]) {
    const prior = groupForCandidates(rows, opts);
    assert.equal(prior.status, 'REJECT');
    assert.deepEqual(groupForRecentCandidates(rows, opts), prior);
  }
});

test('recent-K keeps inputs unchanged and negative groups non-executable', () => {
  const rows = ['c', 'a', 'b'].map(id => episode(id, -1));
  const before = JSON.stringify(rows), optsBefore = JSON.stringify(options);
  const result = groupForRecentCandidates(rows, options);
  assert.equal(JSON.stringify(rows), before);
  assert.equal(JSON.stringify(options), optsBefore);
  assert.equal(Object.isFrozen(rows[0].sourceRefs), false);
  assert.ok(Object.isFrozen(result.selected));
  assert.ok(Object.isFrozen(result.candidates[0].support));
  assert.equal(result.candidates[0].candidateKind, 'avoidance');
  assert.equal(result.candidates[0].promotionInput, null);
  assert.deepEqual(result, groupForCandidates(rows, options));
});

test('recent-K considers the whole eligible pool before applying its bounded selection', () => {
  const rows = Array.from({ length: 300 }, (_, index) => episode(`id${index}`, 1, {
    at: new Date(Date.UTC(2026, 9, 25, 0, index)).toISOString(),
    predictionError: { magnitude: index < 256 ? 1 : 0 },
  }));
  assert.deepEqual(groupForRecentCandidates(rows, { ...options, budget: 3 }).selected.map(row => row.episodeId),
    ['id299', 'id298', 'id297']);
  assert.equal(groupForRecentCandidates(rows, options).selected.length, 32);
  assert.equal(groupForRecentCandidates(rows, { ...options, budget: 256 }).selected.length, 256);
  assert.equal(groupForRecentCandidates(rows, { ...options, budget: 257 }).reason, 'invalid_budget');
});

test('recent-K treats an empty or wholly unscorable pool as insufficient', () => {
  for (const rows of [[], [episode('unknown', 1, { predictionError: { status: 'ABSTAIN', magnitude: null } })]]) {
    const result = groupForRecentCandidates(rows, options);
    assert.equal(result.status, 'INSUFFICIENT');
    assert.deepEqual(result.selected, []);
    assert.deepEqual(result, groupForCandidates(rows, options));
  }
});

test('selects measured episodes deterministically and emits frozen candidate-only data', () => {
  const rows = ['a', 'b', 'c'].map(id => episode(id));
  const before = JSON.stringify(rows);
  const result = groupForCandidates(rows, options);
  assert.equal(MIN_GROUP_SIZE, 3); assert.equal(CONSISTENCY_MIN, 0.8);
  assert.equal(result.status, 'MEASURED');
  assert.equal(result.authority, 'CANDIDATE_ONLY');
  assert.equal(result.registered, false);
  assert.deepEqual(result.selected.map(row => row.episodeId), ['a', 'b', 'c']);
  assert.equal(result.candidates.length, 1);
  const candidate = result.candidates[0];
  assert.equal(candidate.candidateKind, 'procedure');
  assert.equal(candidate.rewardSign, 'positive');
  assert.equal(candidate.nIndependent, 3);
  assert.equal(candidate.consistency, 1);
  assert.deepEqual(candidate.support, ['a', 'b', 'c']);
  assert.deepEqual(candidate.counterexamples, []);
  assert.equal(candidate.promotionInput, null);
  assert.equal(candidate.authority, 'CANDIDATE_ONLY');
  assert.equal(candidate.registered, false);
  assert.ok(Object.isFrozen(candidate.support));
  assert.deepEqual(result.replayTags, [{ workspaceId: 'default', key: 'cap:stored-ab', frameTask: 'replace_text', replayedAt: '2026-10-26T00:00:00.000Z' }]);
  assert.deepEqual(result, groupForCandidates([...rows].reverse(), options));
  assert.equal(JSON.stringify(rows), before);
});

test('keeps the existing replay budget and abstained/missing outcomes cannot provide support', () => {
  const rows = ['a', 'b', 'c'].map(id => episode(id));
  assert.equal(groupForCandidates(rows, { ...options, budget: 2 }).candidates.length, 0);
  assert.deepEqual(groupForCandidates(rows, { ...options, budget: 2 }).selected.map(row => row.episodeId), ['a', 'b']);
  const unknown = [episode('pe', 1, { predictionError: { status: 'ABSTAIN', magnitude: null } }),
    episode('reported', 1, { reward: { status: 'ABSTAIN', rpe: null, reward: null } }),
    episode('missing', 1, { reward: { rpe: 1 } })];
  const result = groupForCandidates([...rows, ...unknown], options);
  assert.deepEqual(result.candidates[0].support, ['a', 'b', 'c']);
  assert.deepEqual(result.skipped.map(row => row.episodeId), ['missing', 'pe', 'reported']);
});

test('counts source correlation across budget-excluded and abstained bridge records', () => {
  const rows = ['a', 'b', 'c'].map(id => episode(id));
  rows.push(episode('bridge', 1, { sourceGroup: null, sourceRefs: ['source:a', 'source:b', 'source:c'],
    predictionError: { status: 'ABSTAIN', magnitude: null } }));
  assert.equal(groupForCandidates(rows, options).candidates.length, 0);
  const unseenBridge = episode('bridge', 1, { sourceGroup: null, sourceRefs: ['source:a', 'source:b', 'source:c'],
    predictionError: { magnitude: 0 }, reward: { reward: 1, rpe: 0 } });
  assert.equal(groupForCandidates([...rows.slice(0, 3), unseenBridge], { ...options, budget: 3 }).candidates.length, 0);
  assert.equal(groupForCandidates(['a', 'b', 'c'].map(id => episode(id, 1, { sourceGroup: null })), options).candidates.length, 0);
});

test('counterexamples and correlated repetitions cannot manufacture consistency', () => {
  const rows = ['a', 'b', 'c', 'd'].map(id => episode(id));
  rows.push(episode('negative', -1));
  const candidate = groupForCandidates(rows, options).candidates[0];
  assert.equal(candidate.consistency, 0.8);
  assert.deepEqual(candidate.counterexamples, ['negative']);
  assert.equal(groupForCandidates(rows.slice(0, 3).concat(episode('negative', -1)), options).candidates.length, 0);
  const repeated = Array.from({ length: 12 }, (_, i) => episode(`repeat-${i}`, 1, { sourceGroup: 'group:a', sourceRefs: ['source:a'] }));
  const balanced = ['n1', 'n2', 'n3'].map(id => episode(id, -1));
  assert.equal(groupForCandidates([...rows.slice(0, 3), ...repeated, ...balanced], options).candidates.length, 0);
});

test('negative-only groups are avoidance patterns, never executable positive procedures', () => {
  const result = groupForCandidates(['a', 'b', 'c'].map(id => episode(id, -1)), options);
  assert.equal(result.status, 'MEASURED');
  assert.equal(result.candidates[0].candidateKind, 'avoidance');
  assert.equal(result.candidates[0].rewardSign, 'negative');
  assert.equal(result.candidates[0].promotionInput, null);
  assert.equal(result.candidates[0].registered, false);
});

test('isolates workspace, frame and replay time without using future source bridges', () => {
  const rows = ['a', 'b', 'c'].map(id => episode(id));
  const baseline = groupForCandidates(rows, options);
  const other = episode('other', -1, { workspaceId: 'other', extra: true });
  const future = episode('future', -1, { at: '2026-10-27T00:00:00Z', sourceGroup: null, sourceRefs: ['source:a', 'source:b', 'source:c'] });
  const result = groupForCandidates([...rows, other, future], options);
  assert.deepEqual(result.candidates, baseline.candidates);
  assert.deepEqual(result.skipped, [{ episodeId: 'future', reason: 'future_episode' }]);
  assert.equal(groupForCandidates([episode('a'), episode('b'), episode('c', 1, { frameTask: 'different' })], options).candidates.length, 0);
});

test('rejects policy/capability artifacts, malformed boundaries and unknown fields', () => {
  const rows = ['a', 'b', 'c'].map(id => episode(id));
  for (const patch of [{ artifactType: 'policy' }, { artifactType: 'capability' }, { key: 'policy:firewall' },
    { key: 'capability:approve' }, { extra: true }, { frameTask: '' }, { sourceRefs: [1] }, { sourceGroup: ' ' }]) {
    assert.equal(groupForCandidates([episode('a', 1, patch)], options).status, 'REJECT');
  }
  for (const opts of [{}, { ...options, replayedAt: 'bad' }, { ...options, replayedAt: '2026-10-26' },
    { ...options, budget: 0 }, { ...options, extra: true }]) assert.equal(groupForCandidates(rows, opts).status, 'REJECT');
  assert.equal(groupForCandidates([episode('a'), episode('a')], options).status, 'REJECT');
  assert.equal(groupForCandidates([episode('a'), episode('a', -1, { at: '2026-10-27T00:00:00Z' })], options).reason, 'duplicate_episode');
  assert.equal(groupForCandidates([], options).status, 'INSUFFICIENT');
});
