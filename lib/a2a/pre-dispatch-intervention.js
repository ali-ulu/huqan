'use strict';

const { snapshotUntrustedData, canonicalHash } = require('./bounded-exchange-values');
const { ACTION_KEYS, CONSTRAINT_KEYS, RISK_ORDER, SHA256 } = require('./bounded-exchange-contract');

const MUTABLE_FIELDS = new Set(['requestedAction', 'constraints', 'expiresAt']);
const ACTION_BINDINGS = ['capability', 'target', 'tool', 'connector'];

function text(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
}

function stringSet(value) {
  return Array.isArray(value) && value.length <= 16 && value.every(text)
    && new Set(value).size === value.length;
}

function validateHandoff(message, context) {
  if (!message || !text(message.exchangeId) || message.workspaceId !== context.workspaceId
      || message.source?.agentId !== context.sourceAgentId || !text(message.target?.agentId)
      || message.source.agentId === message.target.agentId) return false;
  const action = message.requestedAction;
  const constraints = message.constraints;
  return Boolean(action && constraints && Object.keys(action).length === ACTION_KEYS.length
    && Object.keys(action).every(key => ACTION_KEYS.includes(key))
    && Object.keys(constraints).length === CONSTRAINT_KEYS.length
    && Object.keys(constraints).every(key => CONSTRAINT_KEYS.includes(key))
    && ACTION_BINDINGS.every(key => text(action[key]))
    && SHA256.test(action.parametersHash) && Object.hasOwn(RISK_ORDER, action.riskTier)
    && Object.hasOwn(RISK_ORDER, constraints.maxRiskTier)
    && RISK_ORDER[action.riskTier] <= RISK_ORDER[constraints.maxRiskTier]
    && stringSet(constraints.allowedTools) && constraints.allowedTools.includes(action.tool)
    && stringSet(constraints.allowedConnectors) && constraints.allowedConnectors.includes(action.connector));
}

function protectedView(message) {
  return Object.fromEntries(Object.entries(message).filter(([key]) => !MUTABLE_FIELDS.has(key)));
}

function narrowsMessage(original, candidate, context) {
  if (!validateHandoff(candidate, context)
      || canonicalHash(protectedView(original)) !== canonicalHash(protectedView(candidate))) return false;
  const before = original.requestedAction;
  const after = candidate.requestedAction;
  // Parameters may change, but identity, destination and capability may not.
  if (!ACTION_BINDINGS.every(key => before[key] === after[key])
      || RISK_ORDER[after.riskTier] > RISK_ORDER[before.riskTier]) return false;
  const a = original.constraints;
  const b = candidate.constraints;
  if (RISK_ORDER[b.maxRiskTier] > RISK_ORDER[a.maxRiskTier]
      || !b.allowedTools.every(tool => a.allowedTools.includes(tool))
      || !b.allowedConnectors.every(connector => a.allowedConnectors.includes(connector))) return false;
  if (candidate.expiresAt !== original.expiresAt) {
    const expiry = Date.parse(candidate.expiresAt);
    const previous = Date.parse(original.expiresAt);
    if (!Number.isFinite(expiry) || !Number.isFinite(previous) || expiry > previous) return false;
  }
  return true;
}

function normalizeIntervention(value, original, context) {
  const decision = snapshotUntrustedData(value);
  if (!decision || !['allow', 'drop', 'modify'].includes(decision.decision)
      || !text(decision.reason)
      || Object.keys(decision).some(key => !['decision', 'reason', 'message'].includes(key))) {
    return Object.freeze({ decision: 'drop', reason: 'intervention_invalid', message: original });
  }
  if (decision.decision === 'modify') {
    const message = decision.message;
    if (!message || !narrowsMessage(original, message, context)) {
      return Object.freeze({ decision: 'drop', reason: 'intervention_scope_expansion', message: original });
    }
    return Object.freeze({ ...decision, message });
  }
  if (Object.hasOwn(decision, 'message')) {
    return Object.freeze({ decision: 'drop', reason: 'intervention_invalid', message: original });
  }
  return Object.freeze({ ...decision, message: original });
}

// Preparation can rebuild signatures/evidence, never silently substitute the
// action the interceptor and local admission actually evaluated.
function preparedMatches(candidate, prepared) {
  return Boolean(prepared && ['schemaVersion', 'exchangeId', 'workspaceId', 'source', 'target', 'participants',
    'delegation', 'requestedAction', 'constraints', 'issuedAt', 'expiresAt', 'nonce']
    .every(key => canonicalHash(candidate[key] ?? null) === canonicalHash(prepared[key] ?? null)));
}

module.exports = Object.freeze({ validateHandoff, normalizeIntervention, preparedMatches });
