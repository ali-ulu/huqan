'use strict';

const { isPlainObject } = require('../is-plain-object');
const { AUTHORITY, freezeResult, round6 } = require('./contract');
const { selectReplay, prioritizeEpisodes, DEFAULT_REPLAY_BUDGET, MAX_REPLAY_BUDGET } = require('./replay-priority');
const { countIndependentSources } = require('./independent-sources');

const SCHEMA_VERSION = 'huqan-cognition-replay-v1';
const MIN_GROUP_SIZE = 3;
const CONSISTENCY_MIN = 0.8;
const PRIORITY_FIELDS = ['episodeId', 'workspaceId', 'key', 'frameTask', 'at', 'predictionError', 'reward', 'sourceRefs'];
const FIELDS = [...PRIORITY_FIELDS, 'sourceGroup', 'artifactType'];
const text = value => typeof value === 'string' && value.trim() !== '' && value === value.trim();
const time = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value));
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const groupKey = episode => JSON.stringify([episode.workspaceId, episode.key, episode.frameTask]);
const sign = episode => Math.sign(episode.reward.reward);
const measuredReward = reward => isPlainObject(reward)
  && (reward.status === undefined || reward.status === 'MEASURED')
  && typeof reward.reward === 'number' && Number.isFinite(reward.reward) && Math.abs(reward.reward) <= 1;

function candidateFor(events, dependencies, rewardSign) {
  const direction = rewardSign === 'positive' ? 1 : -1;
  const support = events.filter(event => sign(event) === direction);
  const nIndependent = countIndependentSources(support, dependencies);
  if (support.length < MIN_GROUP_SIZE || nIndependent < MIN_GROUP_SIZE) return null;
  const signSupport = [-1, 0, 1].reduce((total, value) => total
    + countIndependentSources(events.filter(event => sign(event) === value), dependencies), 0);
  // Duplicated sources cannot inflate consistency; mixed components count against both signs.
  const consistency = Math.min(support.length / events.length, nIndependent / signSupport);
  if (consistency < CONSISTENCY_MIN) return null;
  const first = events[0];
  return {
    workspaceId: first.workspaceId, key: first.key, frameTask: first.frameTask,
    candidateKind: direction === 1 ? 'procedure' : 'avoidance', rewardSign,
    support: support.map(event => event.episodeId).sort(compareText),
    counterexamples: events.filter(event => sign(event) !== direction).map(event => event.episodeId).sort(compareText),
    sourceRefs: [...new Set(support.flatMap(event => event.sourceRefs))].sort(compareText),
    nIndependent, consistency: round6(consistency), promotionInput: null,
    registered: false, authority: AUTHORITY.CANDIDATE_ONLY,
  };
}

function selectRecent(episodes, { budget }) {
  const result = prioritizeEpisodes(episodes);
  const selected = [...result.ranked]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || compareText(a.episodeId, b.episodeId))
    .slice(0, budget).map(({ episodeId, priority }) => ({ episodeId, priority }));
  return { ...result, selected };
}

function groupUsingSelection(episodes, options, select) {
  let workspaceId = null, replayedAt = null, budget = null;
  const finish = (status, reason, selected = [], skipped = [], candidates = [], replayTags = []) => freezeResult({
    schemaVersion: SCHEMA_VERSION, status, reason, workspaceId, replayedAt, budget,
    selected, skipped, candidates, replayTags, registered: false, authority: AUTHORITY.CANDIDATE_ONLY,
  });
  const reject = reason => finish('REJECT', reason);
  if (!Array.isArray(episodes) || !isPlainObject(options)
    || Object.keys(options).some(key => !['workspaceId', 'budget', 'replayedAt'].includes(key))
    || !text(options.workspaceId) || !time(options.replayedAt)) return reject('invalid_input');
  workspaceId = options.workspaceId;
  replayedAt = new Date(options.replayedAt).toISOString();
  budget = options.budget === undefined ? DEFAULT_REPLAY_BUDGET : options.budget;
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > MAX_REPLAY_BUDGET) return reject('invalid_budget');
  const scoped = [], future = [], identities = new Set();
  for (const episode of episodes) {
    if (!isPlainObject(episode) || !text(episode.workspaceId)) return reject('invalid_episode');
    if (episode.workspaceId !== workspaceId) continue;
    if (Object.keys(episode).some(key => !FIELDS.includes(key))
      || ![episode.episodeId, episode.key, episode.frameTask].every(text) || !time(episode.at)
      || (episode.sourceGroup !== undefined && episode.sourceGroup !== null && !text(episode.sourceGroup))
      || (episode.sourceRefs !== undefined && (!Array.isArray(episode.sourceRefs) || !episode.sourceRefs.every(text)))) return reject('invalid_episode');
    if ((episode.artifactType !== undefined && episode.artifactType !== 'procedure')
      || /^(?:policy|capability)(?::|$)/iu.test(episode.key)) return reject('forbidden_artifact');
    if (identities.has(episode.episodeId)) return reject('duplicate_episode');
    identities.add(episode.episodeId);
    if (Date.parse(episode.at) > Date.parse(replayedAt)) {
      future.push({ episodeId: episode.episodeId, reason: 'future_episode' });
      continue;
    }
    scoped.push({ ...episode, sourceRefs: [...new Set(episode.sourceRefs || [])].sort(compareText) });
  }
  const projected = scoped.map(episode => {
    const row = Object.fromEntries(PRIORITY_FIELDS.map(key => [key, episode[key]]));
    if (!measuredReward(episode.reward)) row.reward = { status: 'ABSTAIN', rpe: null };
    return row;
  });
  const selection = select(projected, { budget });
  if (selection.status === 'REJECT') return reject(selection.reason);
  const skipped = [...selection.skipped, ...future].sort((a, b) => compareText(a.episodeId, b.episodeId));
  const selectedIds = new Set(selection.selected.map(row => row.episodeId));
  const groups = new Map();
  for (const episode of scoped.filter(row => selectedIds.has(row.episodeId))) {
    const key = groupKey(episode);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(episode);
  }
  const candidates = [], replayTags = [];
  for (const [key, events] of [...groups].sort(([a], [b]) => compareText(a, b))) {
    const dependencies = scoped.filter(episode => groupKey(episode) === key);
    for (const rewardSign of ['positive', 'negative']) {
      const candidate = candidateFor(events, dependencies, rewardSign);
      if (candidate) candidates.push(candidate);
    }
    const first = events[0];
    replayTags.push({ workspaceId, key: first.key, frameTask: first.frameTask, replayedAt });
  }
  return finish(candidates.length ? 'MEASURED' : 'INSUFFICIENT', candidates.length ? 'candidate_patterns' : 'insufficient_independent_consistency',
    selection.selected, skipped, candidates, replayTags);
}

function groupForCandidates(episodes, options = {}) {
  return groupUsingSelection(episodes, options, selectReplay);
}

function groupForRecentCandidates(episodes, options = {}) {
  return groupUsingSelection(episodes, options, selectRecent);
}

module.exports = { SCHEMA_VERSION, MIN_GROUP_SIZE, CONSISTENCY_MIN, groupForCandidates, groupForRecentCandidates };
