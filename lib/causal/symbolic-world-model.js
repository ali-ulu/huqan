'use strict';

const { stable, state, action, actionKey } = require('./causal-episode-contract');

const MAX_PLAN_STEPS = 8;
const MAX_PLANS = 16;
const DEFAULT_ROLLOUT_OPERATIONS = 100000;
const CAVEATS = Object.freeze([
  'predicted intermediate states are model outputs, not observations',
  'support score counts independent controlled pairs; it is not a calibrated probability',
  'no action was executed; the host re-runs admission and approval before execution',
]);

function matches(current, goal) { return Object.keys(goal).every(key => current[key] === goal[key]); }
function plan(value, field = 'plan') {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PLAN_STEPS) throw new TypeError(`${field} must have 1-${MAX_PLAN_STEPS} actions`);
  return Object.freeze(value.map(action));
}
function decide(evaluatePolicy, request) {
  try {
    const decision = typeof evaluatePolicy === 'function' ? evaluatePolicy(request) : null;
    if (decision && decision.verdict === 'allow') return null;
    return typeof decision?.reason === 'string' ? decision.reason : 'policy_unknown_or_unavailable';
  } catch { return 'policy_unknown_or_unavailable'; }
}
function stopped(status, reason, steps, at, details = {}) {
  return Object.freeze({ level: 2, status, reason, stoppedAt: at, steps: Object.freeze(steps), finalState: null,
    goalReached: null, totalCost: null, supportFloor: null, authority: 'PREDICTIVE_MODEL_ONLY', executes: false, ...details });
}

/**
 * Level 2 of the symbolic world model: a bounded multistep counterfactual
 * rollout over Level 1 learned single-step transitions. Level 0 is the existing
 * graph traversal (CausalSimulator.simulateChange); it is association evidence,
 * never a transition, so it is not consulted here.
 *
 * The rollout never extrapolates past what it cannot support: the first
 * policy refusal or UNKNOWN transition stops it and finalState stays null, so
 * an unobserved outcome cannot be scored as reaching a goal. `model` is one
 * consistent snapshot ({ workspaceId, frameId, forward, evaluatePolicy }).
 */
function rollout(model, { preState, plan: proposed, desiredState, maxOperations = DEFAULT_ROLLOUT_OPERATIONS } = {}) {
  if (!model || typeof model.forward !== 'function') throw new TypeError('world model snapshot required');
  if (!Number.isInteger(maxOperations) || maxOperations < 1 || maxOperations > 1000000) throw new TypeError('maxOperations must be bounded positive integer');
  const steps = [];
  const goal = desiredState === undefined ? null : state(desiredState, 'desiredState');
  const actions = plan(proposed);
  let current = state(preState);
  let operations = 0;
  for (const [index, step] of actions.entries()) {
    const refusal = decide(model.evaluatePolicy, Object.freeze({ workspaceId: model.workspaceId, frameId: model.frameId, preState: current, action: step }));
    if (refusal) return stopped('REJECTED', refusal, steps, index, { rejectedAction: step, operations });
    const prediction = model.forward({ preState: current, action: step });
    operations += prediction.operations || 0;
    if (operations > maxOperations) return stopped('UNKNOWN', 'rollout_operation_budget_exhausted', steps, index, { operations });
    if (prediction.status !== 'PREDICTED') return stopped('UNKNOWN', prediction.reason, steps, index, { unknownAction: step, operations });
    steps.push(Object.freeze({ index, action: step, preState: current, preStateOrigin: index === 0 ? 'observed' : 'predicted',
      postState: prediction.postState, effect: prediction.effect, modelId: prediction.modelId, conditions: prediction.conditions,
      support: prediction.support, independentSamples: prediction.independentSamples }));
    current = prediction.postState;
  }
  return Object.freeze({ level: 2, status: 'PREDICTED', reason: 'supported_multistep_rollout', stoppedAt: null, steps: Object.freeze(steps),
    finalState: current, goalReached: goal ? matches(current, goal) : null,
    totalCost: actions.reduce((total, step) => total + step.cost, 0),
    supportFloor: Math.min(...steps.map(step => step.independentSamples)), operations,
    authority: 'PREDICTIVE_MODEL_ONLY', executes: false });
}

const DISPOSITION = Object.freeze({ PREDICTED: 'goal_not_reached', UNKNOWN: 'unknown', REJECTED: 'policy_rejected' });
/**
 * Compare at least two plans toward one goal. Every plan stays visible with a
 * disposition, so a reader sees what was chosen, what was cheaper but
 * unsupported, and what policy refused. Ties break by cost, length, then key.
 */
function compare(model, { preState, desiredState, plans, maxOperations } = {}) {
  if (!Array.isArray(plans) || plans.length < 2 || plans.length > MAX_PLANS) throw new TypeError(`compare needs 2-${MAX_PLANS} plans`);
  const goal = state(desiredState, 'desiredState');
  const rollouts = plans.map((proposed, index) => ({ index, plan: plan(proposed, `plans[${index}]`),
    rollout: rollout(model, { preState, plan: proposed, desiredState: goal, maxOperations }) }));
  const feasible = rollouts.filter(entry => entry.rollout.status === 'PREDICTED' && entry.rollout.goalReached === true)
    .sort((a, b) => a.rollout.totalCost - b.rollout.totalCost || a.plan.length - b.plan.length
      || stable(a.plan.map(actionKey)).localeCompare(stable(b.plan.map(actionKey))));
  const selected = feasible[0] || null;
  const alternatives = rollouts.map(entry => Object.freeze({ index: entry.index, plan: entry.plan, status: entry.rollout.status,
    disposition: entry === selected ? 'selected' : feasible.includes(entry) ? 'feasible_not_selected' : DISPOSITION[entry.rollout.status],
    reason: entry.rollout.reason, rollout: entry.rollout }));
  return Object.freeze({ level: 2, status: selected ? 'SELECTED' : 'UNKNOWN',
    reason: selected ? 'cheapest_supported_policy_allowed_plan' : 'no_supported_policy_allowed_plan_reaches_goal',
    selected: selected ? alternatives[selected.index] : null, alternatives: Object.freeze(alternatives),
    authority: 'PREDICTIVE_MODEL_ONLY', executes: false });
}

/** A structured account of why a rollout predicts what it predicts, and where it stops. */
function explainPrediction(result) {
  if (!result || result.level !== 2 || !Array.isArray(result.steps)) throw new TypeError('level 2 rollout required');
  const stop = result.stoppedAt === null ? null : Object.freeze({ index: result.stoppedAt, status: result.status, reason: result.reason,
    action: result.rejectedAction || result.unknownAction || null });
  return Object.freeze({ level: 2, status: result.status,
    steps: Object.freeze(result.steps.map(step => Object.freeze({ index: step.index, action: step.action.name, preStateOrigin: step.preStateOrigin,
      effect: step.effect, modelId: step.modelId, conditions: step.conditions, independentSamples: step.independentSamples, supportSources: step.support.length }))),
    stop, supportFloor: result.supportFloor, caveats: CAVEATS });
}

module.exports = { rollout, compare, explainPrediction, MAX_PLAN_STEPS, MAX_PLANS, DEFAULT_ROLLOUT_OPERATIONS };
