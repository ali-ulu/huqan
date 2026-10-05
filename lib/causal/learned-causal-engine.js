'use strict';

const { stable, digest, state, action, actionKey, delta } = require('./causal-episode-contract');

const MAX_EPISODES = 512;
const DEFAULT_MIN_SUPPORT = 3;
function matches(current, conditions) { return Object.keys(conditions).every(key => current[key] === conditions[key]); }
function unknown(reason, details = {}) { return Object.freeze({ status: 'UNKNOWN', reason, postState: null, effect: null, support: [], ...details }); }
function subsets(keys) {
  return Array.from({ length: 2 ** keys.length }, (_, mask) => keys.filter((_, i) => mask & (1 << i)))
    .sort((a, b) => a.length - b.length || stable(a).localeCompare(stable(b)));
}
function independentPairs(pairs) {
  const groups = [];
  for (const pair of pairs) {
    const identifiers = new Set([`ind:${pair.treatment.assignment.independenceKey}`, `run:${pair.treatment.runId}`, `run:${pair.control.runId}`]);
    const overlaps = groups.filter(group => [...identifiers].some(id => group.identifiers.has(id)));
    for (const group of overlaps) {
      group.identifiers.forEach(id => identifiers.add(id));
      groups.splice(groups.indexOf(group), 1);
    }
    groups.push({ identifiers, pairs: [...overlaps.flatMap(group => group.pairs), pair] });
  }
  return groups;
}
/**
 * A bounded single-step symbolic learner. It never writes canonical graph rules.
 * A controlled pair's assignment is a host assertion, not external causal proof.
 * Controls match the complete pre-state and independence group; observations
 * cannot be promoted merely because they precede an effect.
 */
class LearnedCausalEngine {
  constructor({ episodes = [], withdrawn = [], minSupport = DEFAULT_MIN_SUPPORT, maxOperations = 20000 } = {}) {
    if (!Number.isInteger(minSupport) || minSupport < 3 || minSupport > 512) throw new TypeError('minSupport must be between 3 and 512');
    if (!Number.isInteger(maxOperations) || maxOperations < 1 || maxOperations > 1000000) throw new TypeError('maxOperations must be bounded positive integer');
    if (!Array.isArray(episodes) || episodes.length > MAX_EPISODES) throw new TypeError('episode budget exceeded');
    this.minSupport = minSupport;
    this.maxOperations = maxOperations;
    const revoked = new Set(withdrawn);
    this.episodes = episodes.filter(item => !revoked.has(item.sourceHash));
  }

  _pairs() {
    const groups = new Map();
    for (const episode of this.episodes) {
      if (episode.assignment.kind !== 'controlled') continue;
      const key = stable([episode.workspaceId, episode.frameId, episode.assignment.pairId]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(episode);
    }
    const pairs = [];
    for (const group of groups.values()) {
      const treatments = group.filter(item => item.assignment.arm === 'treatment');
      const controls = group.filter(item => item.assignment.arm === 'control');
      // Ambiguous or incomplete assignment is abstention, never first-row wins.
      if (treatments.length !== 1 || controls.length !== 1) continue;
      const treatment = treatments[0];
      const control = controls[0];
      if (stable(treatment.preState) !== stable(control.preState)
        || treatment.assignment.independenceKey !== control.assignment.independenceKey
        || actionKey(treatment.action) === actionKey(control.action)
        || stable(control.effect) !== '{}') continue;
      pairs.push({ treatment, control });
    }
    return pairs;
  }

  forward({ workspaceId, frameId, preState, action: proposed } = {}) {
    const current = state(preState);
    const requested = action(proposed);
    const pairs = this._pairs().filter(pair => pair.treatment.workspaceId === workspaceId && pair.treatment.frameId === frameId
      && actionKey(pair.treatment.action) === actionKey(requested)
      && stable(Object.keys(pair.treatment.preState)) === stable(Object.keys(current)));
    if (pairs.length < this.minSupport) return unknown('insufficient_controlled_independent_support');
    let operations = 0;
    for (const keys of subsets(Object.keys(current))) {
      const conditions = Object.fromEntries(keys.map(key => [key, current[key]]));
      const selected = [];
      for (const pair of pairs) {
        operations++;
        if (operations > this.maxOperations) return unknown('operation_budget_exhausted', { operations });
        if (matches(pair.treatment.preState, conditions)) selected.push(pair);
      }
      const independent = independentPairs(selected);
      if (independent.length < this.minSupport) continue;
      const effect = selected[0].treatment.effect;
      if (selected.some(pair => stable(pair.treatment.effect) !== stable(effect))) continue;
      // A dimension that never varied is a condition, not proof that the
      // mechanism ignores it. Only varied nuisance dimensions may transfer.
      const supportedConditions = { ...conditions };
      for (const key of Object.keys(current)) {
        const values = new Set(selected.map(pair => pair.treatment.preState[key]));
        if (values.size === 1) supportedConditions[key] = selected[0].treatment.preState[key];
      }
      if (!matches(current, supportedConditions)) continue;
      // Verified contrary outcomes can defeat a model even without a matched
      // control. They cannot establish a replacement causal law themselves.
      const contrary = this.episodes.some(episode => episode.assignment.arm === 'treatment'
        && episode.workspaceId === workspaceId && episode.frameId === frameId
        && actionKey(episode.action) === actionKey(requested)
        && stable(Object.keys(episode.preState)) === stable(Object.keys(current))
        && matches(episode.preState, supportedConditions) && stable(episode.effect) !== stable(effect));
      if (contrary) continue;
      // Bind all corroborating and correlated sources so withdrawal is visible.
      const support = selected.flatMap(pair => [pair.treatment.sourceHash, pair.control.sourceHash]).sort();
      const postState = Object.freeze({ ...current, ...effect });
      return Object.freeze({ status: 'PREDICTED', reason: 'controlled_transition_model', postState, effect,
        modelId: digest({ workspaceId, frameId, action: actionKey(requested), conditions: supportedConditions, effect, support }),
        conditions: Object.freeze(supportedConditions), support: Object.freeze(support), independentSamples: independent.length,
        confidence: independent.length / (independent.length + 2), operations,
        authority: 'PREDICTIVE_MODEL_ONLY', canonicalRule: false });
    }
    return unknown('conflicting_or_unseen_conditions', { operations });
  }

  inverse({ workspaceId, frameId, preState, desiredState, actions, evaluatePolicy } = {}) {
    const current = state(preState);
    const goal = state(desiredState, 'desiredState');
    if (!Array.isArray(actions) || actions.length === 0 || actions.length > 32) throw new TypeError('bounded actions required');
    const candidates = [];
    const rejected = [];
    for (const item of actions) {
      const proposed = action(item);
      let decision;
      try { decision = typeof evaluatePolicy === 'function' ? evaluatePolicy(Object.freeze({ workspaceId, frameId, preState: current, action: proposed })) : null; }
      catch { decision = null; }
      if (!decision || decision.verdict !== 'allow') {
        rejected.push(Object.freeze({ action: proposed, reason: typeof decision?.reason === 'string' ? decision.reason : 'policy_unknown_or_unavailable' }));
        continue;
      }
      const prediction = this.forward({ workspaceId, frameId, preState: current, action: proposed });
      if (prediction.status === 'PREDICTED' && matches(prediction.postState, goal)) candidates.push(Object.freeze({ action: proposed, prediction }));
    }
    candidates.sort((a, b) => a.action.cost - b.action.cost || actionKey(a.action).localeCompare(actionKey(b.action)));
    return Object.freeze({ status: candidates.length ? 'CANDIDATES' : 'UNKNOWN', candidates: Object.freeze(candidates), rejected: Object.freeze(rejected),
      reason: candidates.length ? 'policy_allowed_single_step_candidates' : 'no_supported_policy_allowed_candidate' });
  }

  failure({ prediction, preState, observedPostState } = {}) {
    const before = state(preState);
    const observed = state(observedPostState, 'observedPostState');
    if (!prediction || prediction.status !== 'PREDICTED') return unknown('no_prediction_to_compare');
    if (stable(Object.keys(before)) !== stable(Object.keys(observed))) return unknown('incomplete_or_changed_outcome_schema');
    if (!prediction.postState || stable(Object.keys(before)) !== stable(Object.keys(prediction.postState))) return unknown('invalid_prediction_schema');
    const differences = Object.keys(observed).filter(key => observed[key] !== prediction.postState[key]);
    return Object.freeze({ status: differences.length ? 'MISMATCH' : 'CONFIRMED', modelId: prediction.modelId,
      predictedEffect: prediction.effect, observedEffect: delta(before, observed), differences: Object.freeze(differences),
      hypothesis: differences.length ? Object.freeze({ status: 'UNVERIFIED', reason: 'missing_condition_or_changed_mechanism',
        affectedKeys: Object.freeze(differences), canonicalRule: false }) : null });
  }
}
module.exports = { LearnedCausalEngine, MAX_EPISODES, DEFAULT_MIN_SUPPORT };
