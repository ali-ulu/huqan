'use strict';

const { COGNITION_STATUS, AUTHORITY, round6, freezeResult } = require('./contract');
const { RPE_BOUND } = require('./reward-signal');
const { isPlainObject } = require('../is-plain-object');

const SCHEMA_VERSION = 'huqan-cognition-replay-v1';
const PRIORITY_EPSILON = 0.01;
const PRIORITY_ALPHA = 0.6;
const IMPORTANCE_WEIGHT = 1.0;
const DEFAULT_REPLAY_BUDGET = 32;
const MAX_REPLAY_BUDGET = 256;
const FIELDS = ['episodeId', 'workspaceId', 'key', 'frameTask', 'at', 'predictionError', 'reward', 'sourceRefs'];
const text = (value) => typeof value === 'string' && value.trim() !== '' && value === value.trim();
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const measuredNumber = (signal, field, low, high) => isPlainObject(signal)
  && (signal.status === undefined || signal.status === COGNITION_STATUS.MEASURED)
  && typeof signal[field] === 'number' && Number.isFinite(signal[field])
  && signal[field] >= low && signal[field] <= high ? signal[field] : null;

function validEpisode(episode) {
  return isPlainObject(episode) && Object.keys(episode).every((field) => FIELDS.includes(field))
    && text(episode.episodeId) && text(episode.key) && Number.isFinite(Date.parse(episode.at))
    && (episode.sourceRefs === undefined || (Array.isArray(episode.sourceRefs) && episode.sourceRefs.every(text)));
}

// Prioritized replay (Schaul 2016): surprise magnitude, scaled by how far the reward missed expectation.
function prioritizeEpisodes(episodes) {
  const finish = (status, reason, ranked = [], skipped = []) => freezeResult({
    schemaVersion: SCHEMA_VERSION, status, reason, ranked, skipped, authority: AUTHORITY.SIGNAL_ONLY,
  });
  if (!Array.isArray(episodes) || !episodes.every(validEpisode)) return finish(COGNITION_STATUS.REJECT, 'invalid_episode');
  if (new Set(episodes.map((episode) => episode.episodeId)).size !== episodes.length) return finish(COGNITION_STATUS.REJECT, 'duplicate_episode');
  const ranked = [];
  const skipped = [];
  for (const episode of episodes) {
    const magnitude = measuredNumber(episode.predictionError, 'magnitude', 0, 1);
    const rpe = measuredNumber(episode.reward, 'rpe', -RPE_BOUND, RPE_BOUND);
    // An abstained signal is unknown, not zero: the episode is not scored.
    if (magnitude === null || rpe === null) { skipped.push({ episodeId: episode.episodeId, reason: 'signal_not_measured' }); continue; }
    const priority = (magnitude + PRIORITY_EPSILON) ** PRIORITY_ALPHA * (1 + IMPORTANCE_WEIGHT * Math.abs(rpe) / RPE_BOUND);
    ranked.push({ episodeId: episode.episodeId, key: episode.key, at: new Date(episode.at).toISOString(), priority: round6(priority) });
  }
  ranked.sort((a, b) => b.priority - a.priority || Date.parse(b.at) - Date.parse(a.at) || compareText(a.episodeId, b.episodeId));
  skipped.sort((a, b) => compareText(a.episodeId, b.episodeId));
  if (ranked.length === 0) return finish(COGNITION_STATUS.INSUFFICIENT, 'no_scorable_episodes', ranked, skipped);
  return finish(COGNITION_STATUS.MEASURED, 'prioritized_episodes', ranked, skipped);
}

// Deterministic top-budget selection; no sampling, no candidate registration.
function selectReplay(episodes, options = {}) {
  if (!isPlainObject(options) || Object.keys(options).some((key) => key !== 'budget')) {
    return freezeResult({ schemaVersion: SCHEMA_VERSION, status: COGNITION_STATUS.REJECT, reason: 'invalid_options', budget: null, selected: [], skipped: [], authority: AUTHORITY.SIGNAL_ONLY });
  }
  const budget = options.budget === undefined ? DEFAULT_REPLAY_BUDGET : options.budget;
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > MAX_REPLAY_BUDGET) {
    return freezeResult({ schemaVersion: SCHEMA_VERSION, status: COGNITION_STATUS.REJECT, reason: 'invalid_budget', budget: null, selected: [], skipped: [], authority: AUTHORITY.SIGNAL_ONLY });
  }
  const { status, reason, ranked, skipped } = prioritizeEpisodes(episodes);
  const selected = ranked.slice(0, budget).map(({ episodeId, priority }) => ({ episodeId, priority }));
  return freezeResult({ schemaVersion: SCHEMA_VERSION, status, reason, budget, selected, skipped, authority: AUTHORITY.SIGNAL_ONLY });
}

module.exports = {
  SCHEMA_VERSION, PRIORITY_EPSILON, PRIORITY_ALPHA, IMPORTANCE_WEIGHT, DEFAULT_REPLAY_BUDGET, MAX_REPLAY_BUDGET,
  prioritizeEpisodes, selectReplay,
};
