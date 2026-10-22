'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { prioritizeEpisodes, selectReplay, DEFAULT_REPLAY_BUDGET } = require('../lib/cognition/replay-priority');

const episode = (episodeId, magnitude, rpe, extra = {}) => ({ episodeId, workspaceId: 'default', key: 'cap:stored-ab', frameTask: 'rename',
  at: '2026-10-19T03:00:00Z', predictionError: { magnitude }, reward: { reward: -1, rpe }, sourceRefs: ['run_9'], ...extra });

test('prioritizes by error and rpe with deterministic tie-break', () => {
  const rows = [episode('b', 0.5, 0), episode('a', 0.5, 0), episode('hot', 0.8, -1.2), episode('newer', 0.5, 0, { at: '2026-10-20T03:00:00Z' })];
  const result = prioritizeEpisodes(rows);
  assert.equal(result.status, 'MEASURED');
  assert.equal(result.authority, 'SIGNAL_ONLY');
  assert.deepEqual(result.ranked.map((row) => row.episodeId), ['hot', 'newer', 'a', 'b']);
  assert.equal(result.ranked[0].priority, 1.409974);
  assert.deepEqual(result, prioritizeEpisodes([...rows].reverse()));
});

test('skips abstained episodes instead of scoring them', () => {
  const result = prioritizeEpisodes([episode('ok', 0.2, 1), episode('pe', 0, 1, { predictionError: { status: 'ABSTAIN', magnitude: null } }),
    episode('rw', 0.9, 0, { reward: { status: 'ABSTAIN', reward: null, rpe: null } })]);
  assert.deepEqual(result.ranked.map((row) => row.episodeId), ['ok']);
  assert.deepEqual(result.skipped.map((row) => row.episodeId), ['pe', 'rw']);
  assert.equal(prioritizeEpisodes([]).status, 'INSUFFICIENT');
});

test('rejects malformed and duplicate episodes', () => {
  assert.equal(prioritizeEpisodes('x').reason, 'invalid_episode');
  assert.equal(prioritizeEpisodes([{ ...episode('a', 0.1, 0), extra: 1 }]).reason, 'invalid_episode');
  assert.equal(prioritizeEpisodes([episode('a', 0.1, 0), episode('a', 0.2, 0)]).reason, 'duplicate_episode');
});

test('selects the top budget and rejects an out-of-range budget', () => {
  const rows = [episode('a', 0.1, 0), episode('b', 0.9, 0), episode('c', 0.5, 0)];
  assert.deepEqual(selectReplay(rows, { budget: 2 }).selected.map((row) => row.episodeId), ['b', 'c']);
  assert.equal(selectReplay(rows).budget, DEFAULT_REPLAY_BUDGET);
  for (const budget of [0, 257, 1.5, '3']) assert.equal(selectReplay(rows, { budget }).reason, 'invalid_budget');
  assert.equal(selectReplay(rows, { x: 1 }).reason, 'invalid_options');
});
