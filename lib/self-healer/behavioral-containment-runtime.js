'use strict';

/**
 * ASI10 runtime containment orchestration.
 *
 * This is deliberately a logical executor-containment layer, not an IAM or
 * credential revocation system. It records a scoped pause/review/block/
 * quarantine/revoke state and gives the executor a fail-closed suppression
 * decision. A caller must supply the exact workspace and agent scope; there is
 * no global kill switch. Reintegration requires fresh identity, dependency,
 * policy, and operator checks.
 */

const { normalizeWorkspaceId } = require('../workspace-id');

const BEHAVIORAL_RUNTIME_VERSION = 'asi10-behavioral-runtime-v0.1.0';
const MAX_REASON_LENGTH = 160;
const CONTAINMENT_RANK = Object.freeze({ none: 0, review: 1, pause: 2, block: 3, quarantine: 4, revoke: 5 });
const SUPPRESSING_ACTIONS = Object.freeze(['pause', 'review', 'block', 'quarantine', 'revoke']);
const REINTEGRATION_PREREQUISITES = Object.freeze([
  'fresh_identity_verification',
  'fresh_dependency_verification',
  'fresh_policy_verification',
  'operator_approval',
]);

function boundedText(value, fallback = '') {
  const normalized = String(value == null ? '' : value).trim();
  return normalized ? normalized.slice(0, MAX_REASON_LENGTH) : fallback;
}

function scopeOf(input = {}) {
  const workspaceId = normalizeWorkspaceId(input.workspaceId);
  const agentId = boundedText(input.agentId);
  if (!agentId) return null;
  return Object.freeze({ workspaceId, agentId });
}

function scopeKey(scope) {
  return `${scope.workspaceId}\u0000${scope.agentId}`;
}

function actionOf(value) {
  const action = boundedText(value).toLowerCase();
  return Object.prototype.hasOwnProperty.call(CONTAINMENT_RANK, action) ? action : '';
}

function freezeState(state) {
  return Object.freeze({
    ...state,
    scope: Object.freeze({ ...state.scope }),
    reintegration: Object.freeze({
      ...state.reintegration,
      prerequisites: Object.freeze([...state.reintegration.prerequisites]),
    }),
    revocation: state.revocation ? Object.freeze({ ...state.revocation }) : null,
  });
}

function createBehavioralContainmentRuntime({ clock = () => Date.now() } = {}) {
  const states = new Map();

  function nowIso() {
    let now;
    try { now = Number(clock()); } catch (_) { now = Date.now(); }
    if (!Number.isFinite(now)) now = Date.now();
    return new Date(now).toISOString();
  }

  function record({ workspaceId, agentId, action, reason = '', baselineHash = null, deviationCode = null } = {}) {
    const scope = scopeOf({ workspaceId, agentId });
    const requestedAction = actionOf(action);
    if (!scope) return Object.freeze({ ok: false, reason: 'behavioral_scope_required' });
    if (!requestedAction || requestedAction === 'none') {
      return Object.freeze({ ok: true, applied: false, action: 'none', scope });
    }

    const key = scopeKey(scope);
    const previous = states.get(key);
    const effectiveAction = previous && CONTAINMENT_RANK[previous.action] >= CONTAINMENT_RANK[requestedAction]
      ? previous.action
      : requestedAction;
    const createdAt = previous?.createdAt || nowIso();
    const state = freezeState({
      ok: true,
      version: BEHAVIORAL_RUNTIME_VERSION,
      status: 'active',
      applied: true,
      action: effectiveAction,
      executorSuppressed: SUPPRESSING_ACTIONS.includes(effectiveAction),
      scope,
      baselineHash: boundedText(baselineHash, previous?.baselineHash || ''),
      deviationCode: boundedText(deviationCode, previous?.deviationCode || ''),
      reason: boundedText(reason, previous?.reason || 'behavioral containment required'),
      createdAt,
      updatedAt: nowIso(),
      reintegration: {
        required: true,
        operatorApprovalRequired: true,
        outcome: null,
        prerequisites: REINTEGRATION_PREREQUISITES,
      },
      // This is a logical executor-capability revocation marker only. It never
      // claims to revoke provider credentials or mutate an external IAM system.
      revocation: effectiveAction === 'revoke'
        ? { kind: 'logical_executor_capability', credentialsUntouched: true }
        : null,
    });
    states.set(key, state);
    return state;
  }

  function get({ workspaceId, agentId } = {}) {
    const scope = scopeOf({ workspaceId, agentId });
    return scope ? (states.get(scopeKey(scope)) || null) : null;
  }

  function guardExecution({ workspaceId, agentId } = {}) {
    const state = get({ workspaceId, agentId });
    if (!state || state.executorSuppressed !== true) return Object.freeze({ allowed: true, state: null });
    return Object.freeze({
      allowed: false,
      code: `BEHAVIORAL_${state.action.toUpperCase()}_ACTIVE`,
      reason: state.reason,
      state,
    });
  }

  function revoke(input = {}) {
    return record({ ...input, action: 'revoke', reason: input.reason || 'operator requested scoped executor revocation' });
  }

  function reintegrate({ workspaceId, agentId, verification = {}, operatorApproval = false } = {}) {
    const scope = scopeOf({ workspaceId, agentId });
    if (!scope) return Object.freeze({ ok: false, reason: 'behavioral_scope_required' });
    const current = states.get(scopeKey(scope));
    if (!current) return Object.freeze({ ok: false, reason: 'behavioral_containment_not_found', scope });
    const verified = REINTEGRATION_PREREQUISITES.slice(0, 3).every((key) => verification[key] === true)
      && operatorApproval === true;
    if (!verified) {
      return Object.freeze({ ok: false, reason: 'behavioral_reintegration_verification_required', state: current });
    }
    states.delete(scopeKey(scope));
    return Object.freeze({
      ok: true,
      status: 'reintegrated',
      action: 'none',
      applied: true,
      executorSuppressed: false,
      scope,
      priorAction: current.action,
      reintegration: {
        required: false,
        operatorApprovalRequired: false,
        outcome: 'approved',
        prerequisites: [...REINTEGRATION_PREREQUISITES],
      },
    });
  }

  return Object.freeze({
    version: BEHAVIORAL_RUNTIME_VERSION,
    record,
    get,
    guardExecution,
    revoke,
    reintegrate,
  });
}

module.exports = Object.freeze({
  BEHAVIORAL_RUNTIME_VERSION,
  REINTEGRATION_PREREQUISITES,
  createBehavioralContainmentRuntime,
});
