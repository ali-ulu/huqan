'use strict';

const { delta } = require('./causal/causal-episode-contract');

// #3468 B5: a bounded multistep door. Unlock opens it only when energized and
// not jammed; energize and unjam prepare it; release always opens it, dearly.
// Force is policy-blocked. Reset is never trained, so every plan through it
// must stay UNKNOWN. The learner and planner never import execute().
function act(name, cost) { return Object.freeze({ name, args: Object.freeze({}), cost }); }
const ACTIONS = Object.freeze({
  energize: act('energize', 1), unjam: act('unjam', 1), unlock: act('unlock', 2),
  release: act('release', 6), force: act('force', 1), reset: act('reset', 0.5),
});
const TRAINED = Object.freeze([ACTIONS.energize, ACTIONS.unjam, ACTIONS.unlock, ACTIONS.release]);
const PLANS = Object.freeze([
  [ACTIONS.unlock], [ACTIONS.energize, ACTIONS.unlock], [ACTIONS.unjam, ACTIONS.unlock],
  [ACTIONS.energize, ACTIONS.unjam, ACTIONS.unlock], [ACTIONS.release], [ACTIONS.force], [ACTIONS.reset, ACTIONS.unlock],
].map(plan => Object.freeze(plan)));
const GOAL = Object.freeze({ door: true });
const NOOP = Object.freeze({ name: 'noop', args: Object.freeze({}), cost: 0 });
const FRAME = 'bounded-door-multistep-v1';
function policy({ action }) { return { verdict: action.name === 'force' ? 'block' : 'allow', reason: action.name === 'force' ? 'unsafe_force' : 'receiver_policy' }; }
/** The environment is the outcome oracle for every step. */
function execute(preState, action) {
  const next = { ...preState };
  if (action.name === 'energize') next.energized = true;
  if (action.name === 'unjam') next.jammed = false;
  if (action.name === 'reset') next.energized = false;
  if (action.name === 'release' || action.name === 'force' || (action.name === 'unlock' && preState.energized && !preState.jammed)) next.door = true;
  return Object.freeze(next);
}
function executePlan(preState, plan) {
  const states = [];
  let current = preState;
  for (const step of plan) { current = execute(current, step); states.push(current); }
  return states;
}
/** One controlled treatment/control pair from the same pre-state, recorded through the real journal. */
function recordPair(journal, runtime, { id, preState, action, independenceKey = id } = {}) {
  for (const [arm, selected] of [['treatment', action], ['control', NOOP]]) {
    const postState = execute(preState, selected);
    const event = { runId: id, eventId: `${id}-${arm}`, attemptId: `${id}-attempt`, workspaceId: 'default',
      type: 'verification', executionStatus: 'completed', outcomeStatus: 'verified', payload: { causalEpisode: {
        frameId: FRAME, preState, action: selected, postState, effect: delta(preState, postState), observedAt: '2026-01-01T00:00:00.000Z',
        assignment: { kind: 'controlled', pairId: id, arm, independenceKey } } } };
    const recorded = journal.append(event);
    if (!recorded.ok) throw new Error(`world journal refused: ${recorded.code}`);
    runtime.observeJournalEpisode({ runId: id, eventId: event.eventId });
  }
}
module.exports = { ACTIONS, TRAINED, PLANS, GOAL, NOOP, FRAME, policy, execute, executePlan, recordPair };
