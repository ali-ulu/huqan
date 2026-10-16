'use strict';

const { delta } = require('./causal/causal-episode-contract');

const ACTIONS = Object.freeze([
  Object.freeze({ name: 'force', args: Object.freeze({}), cost: 1 }),
  Object.freeze({ name: 'unlock', args: Object.freeze({}), cost: 2 }),
  Object.freeze({ name: 'release', args: Object.freeze({}), cost: 4 }),
]);
const NOOP = Object.freeze({ name: 'noop', args: Object.freeze({}), cost: 0 });
const FRAME = 'bounded-door-v1';
function policy({ action }) { return { verdict: action.name === 'force' ? 'block' : 'allow', reason: action.name === 'force' ? 'unsafe_force' : 'receiver_policy' }; }
/** The environment is the outcome oracle. The learner never imports this law. */
function execute(preState, action) {
  return Object.freeze({ ...preState, door: preState.door || action.name === 'release' || action.name === 'force'
    || (action.name === 'unlock' && preState.energized && !preState.jammed) });
}
function fixture(seed = 3467, count = 160, prefix = 'holdout') {
  if (!Number.isInteger(count) || count < 1 || count > 10000 || !['train', 'holdout', 'transfer'].includes(prefix)) throw new TypeError('bounded fixture split required');
  return Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${seed}-${index}`,
    preState: Object.freeze({ door: false, energized: index % 4 < 2, jammed: index % 2 === 0,
      nuisance: prefix === 'transfer' ? 1000 + index : index % 6 }),
    action: ACTIONS[1] }));
}
/** The real journal captures executor outcomes; models see its immutable read API. */
function recordPair(journal, runtime, { id, preState, action, independenceKey = id, kind = 'controlled', effectOverride } = {}) {
  const sources = [];
  for (const [arm, selected] of [['treatment', action], ['control', NOOP]]) {
    const postState = execute(preState, selected);
    const payload = { frameId: FRAME, preState, action: selected, postState,
      effect: effectOverride || delta(preState, postState), observedAt: '2026-01-01T00:00:00.000Z',
      assignment: { kind, pairId: id, arm, independenceKey } };
    const event = { runId: id, eventId: `${id}-${arm}`, attemptId: `${id}-attempt`, workspaceId: 'default',
      type: 'verification', executionStatus: 'completed', outcomeStatus: 'verified', payload: { causalEpisode: payload } };
    const recorded = journal.append(event);
    if (!recorded.ok) throw new Error(`world journal refused: ${recorded.code}`);
    sources.push(runtime.observeJournalEpisode({ runId: id, eventId: event.eventId }).episode.sourceHash);
  }
  return sources;
}
module.exports = { ACTIONS, NOOP, FRAME, policy, execute, fixture, recordPair };
