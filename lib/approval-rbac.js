'use strict';

// Approval RBAC (#4205, slice of #ENT-RBAC).
//
// Opt-in: with no policy configured the single-user installation behaves
// exactly as before. Once HUQAN_RBAC_POLICY_PATH names a policy, the policy is
// the authority. A policy that is unreadable or malformed refuses every
// decision, and so does a decision whose signed `operatorId` has no role or
// whose role does not grant approvals.decide. There is no fallback identity
// and no partial policy: every path either finds a role or refuses.
//
// The policy is local configuration, not a signed document. It maps the
// identity the approval authority asserts in the signed decision envelope
// (lib/authority/decision-envelope.js) to a role. Protecting the file is the
// deployment's job. SSO (#4204) will change where the authority learns the
// identity, not this mapping.

const crypto = require('node:crypto');
const fs = require('node:fs');
const { readCompatibleEnvironmentVariable } = require('./environment-compat');

const RBAC_POLICY_ENV = 'RBAC_POLICY_PATH';
const POLICY_VERSION = 1;
const API_KEY_HASH = /^[0-9a-f]{64}$/;
const MAX_QUORUM = 16;
const PERMISSIONS = Object.freeze({
  VIEW: 'approvals.view',
  DECIDE: 'approvals.decide',
  MANAGE: 'approvals.manage',
});
const ALLOWED_PERMISSIONS = Object.freeze(Object.values(PERMISSIONS));
const POLICY_FIELDS = Object.freeze(['version', 'roles', 'operators', 'separationOfDuties', 'operatorApiKeyHashes', 'quorum']);
const OPERATOR_ID = /^[A-Za-z0-9_.:@-]{1,128}$/;
const MAX_ROLE = 64;

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalid(reason) {
  return { configured: true, ok: false, reason };
}

function validatePolicy(value) {
  if (!plain(value)) return invalid('policy must be a JSON object');
  const unknown = Object.keys(value).filter(key => !POLICY_FIELDS.includes(key));
  if (unknown.length) return invalid(`unknown policy fields: ${unknown.join(', ')}`);
  if (value.version !== POLICY_VERSION) return invalid(`version must be ${POLICY_VERSION}`);
  if (!plain(value.roles)) return invalid('roles must be an object of role -> permissions');
  if (!plain(value.operators)) return invalid('operators must be an object of operatorId -> role');

  const roles = {};
  for (const [role, permissions] of Object.entries(value.roles)) {
    if (!role || role.length > MAX_ROLE) return invalid(`role names must be 1-${MAX_ROLE} characters`);
    if (!Array.isArray(permissions)) return invalid(`role ${role} must list its permissions`);
    const foreign = permissions.filter(permission => !ALLOWED_PERMISSIONS.includes(permission));
    if (foreign.length) return invalid(`role ${role} lists unknown permission ${foreign[0]}`);
    if (new Set(permissions).size !== permissions.length) return invalid(`role ${role} repeats a permission`);
    roles[role] = Object.freeze([...permissions]);
  }

  const operators = {};
  for (const [operatorId, role] of Object.entries(value.operators)) {
    if (!OPERATOR_ID.test(operatorId)) return invalid(`operator id ${JSON.stringify(operatorId)} is not a bounded identifier`);
    if (!Object.prototype.hasOwnProperty.call(roles, role)) return invalid(`operator ${operatorId} names unknown role ${role}`);
    operators[operatorId] = role;
  }

  if (value.separationOfDuties !== undefined && typeof value.separationOfDuties !== 'boolean') {
    return invalid('separationOfDuties must be a boolean');
  }

  if (value.operatorApiKeyHashes !== undefined && !plain(value.operatorApiKeyHashes)) {
    return invalid('operatorApiKeyHashes must map operatorId to a SHA-256 API-key hash');
  }
  const operatorApiKeyHashes = {};
  const uniqueHashes = new Set();
  for (const [operatorId, hash] of Object.entries(value.operatorApiKeyHashes || {})) {
    if (!Object.prototype.hasOwnProperty.call(operators, operatorId)) {
      return invalid(`API key names unknown operator ${operatorId}`);
    }
    if (!roles[operators[operatorId]].includes(PERMISSIONS.DECIDE)) {
      return invalid(`API key operator ${operatorId} must have approvals.decide`);
    }
    if (typeof hash !== 'string' || !API_KEY_HASH.test(hash)) {
      return invalid(`API key hash for ${operatorId} must be lowercase SHA-256 hex`);
    }
    if (uniqueHashes.has(hash)) return invalid('operator API key hashes must be unique');
    uniqueHashes.add(hash);
    operatorApiKeyHashes[operatorId] = hash;
  }

  const quorumInput = value.quorum === undefined ? {} : value.quorum;
  if (!plain(quorumInput) || Object.keys(quorumInput).some(key => !['default', 'byTool'].includes(key))) {
    return invalid('quorum must contain only default and byTool');
  }
  const defaultQuorum = quorumInput.default === undefined ? 1 : quorumInput.default;
  if (!Number.isInteger(defaultQuorum) || defaultQuorum < 1 || defaultQuorum > MAX_QUORUM) {
    return invalid(`quorum.default must be an integer from 1 to ${MAX_QUORUM}`);
  }
  if (quorumInput.byTool !== undefined && !plain(quorumInput.byTool)) {
    return invalid('quorum.byTool must map tool names to quorum integers');
  }
  const byTool = {};
  for (const [tool, threshold] of Object.entries(quorumInput.byTool || {})) {
    if (!/^[a-z][a-z0-9._-]{0,127}$/.test(tool)) return invalid(`invalid quorum tool name ${tool}`);
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > MAX_QUORUM) {
      return invalid(`quorum for ${tool} must be an integer from 1 to ${MAX_QUORUM}`);
    }
    byTool[tool] = threshold;
  }
  const thresholds = [defaultQuorum, ...Object.values(byTool)];
  const maxThreshold = Math.max(...thresholds);
  if (maxThreshold > 1 && Object.keys(operatorApiKeyHashes).length < maxThreshold) {
    return invalid('quorum above one requires at least N distinct operator API keys with approvals.decide');
  }

  return {
    configured: true,
    ok: true,
    policy: Object.freeze({
      version: POLICY_VERSION,
      roles: Object.freeze(roles),
      operators: Object.freeze(operators),
      separationOfDuties: value.separationOfDuties === true,
      operatorApiKeyHashes: Object.freeze(operatorApiKeyHashes),
      quorum: Object.freeze({ default: defaultQuorum, byTool: Object.freeze(byTool) }),
    }),
  };
}

/**
 * @returns {{configured: false, ok: true} | {configured: true, ok: false, reason: string}
 *   | {configured: true, ok: true, policy: object}}
 */
function loadApprovalRbacPolicy({ readEnvironment = readCompatibleEnvironmentVariable, readFile = fs.readFileSync } = {}) {
  const file = readEnvironment(RBAC_POLICY_ENV);
  if (file === undefined || file === null || file === '') return { configured: false, ok: true };
  let parsed;
  try {
    parsed = JSON.parse(readFile(file, 'utf8'));
  } catch (error) {
    return invalid(`policy ${file} is unreadable: ${error.message}`);
  }
  return validatePolicy(parsed);
}

/**
 * Decide one approval decision against the policy.
 *
 * Denials are total: an unknown or absent operator identity never falls back
 * to a default role, because a runtime that cannot name its operator must not
 * approve anything. Separation of duties compares the signed operator with the
 * requester id recorded on the approval row; that id is declared by the
 * runtime, so the check stops accidental self-approval, not a runtime that
 * lies about who asked.
 *
 * @returns {{ok: true, governed: false} | {ok: true, governed: true, operatorId: string, role: string}
 *   | {ok: false, code: string, message: string, role?: string|null}}
 */
function authorizeApproval({ policy, operatorId, requesterId, permission = PERMISSIONS.DECIDE } = {}) {
  if (!policy || policy.configured !== true) return { ok: true, governed: false };
  if (policy.ok !== true) {
    return { ok: false, code: 'APPROVAL_RBAC_POLICY_INVALID', message: `approval RBAC policy is invalid: ${policy.reason}` };
  }
  if (typeof operatorId !== 'string' || !OPERATOR_ID.test(operatorId)) {
    return { ok: false, code: 'APPROVAL_RBAC_OPERATOR_REQUIRED',
      message: 'approval RBAC policy is configured but the decision carries no signed operator identity' };
  }
  const role = Object.prototype.hasOwnProperty.call(policy.policy.operators, operatorId)
    ? policy.policy.operators[operatorId]
    : null;
  if (!role) {
    return { ok: false, code: 'APPROVAL_RBAC_OPERATOR_UNKNOWN', message: `operator ${operatorId} has no role in the approval RBAC policy` };
  }
  if (!policy.policy.roles[role].includes(permission)) {
    return { ok: false, code: 'APPROVAL_RBAC_PERMISSION_DENIED', role,
      message: `role ${role} does not grant ${permission}` };
  }
  if (permission === PERMISSIONS.DECIDE && policy.policy.separationOfDuties
    && typeof requesterId === 'string' && requesterId === operatorId) {
    return { ok: false, code: 'APPROVAL_RBAC_SEPARATION_OF_DUTIES', role,
      message: `operator ${operatorId} requested this approval and cannot decide it` };
  }
  return { ok: true, governed: true, operatorId, role };
}

function resolveApprovalOperator({ policy, apiKey, fallbackOperatorId } = {}) {
  if (!policy || policy.configured !== true) {
    return { ok: true, operatorId: fallbackOperatorId || null, source: 'legacy_totp', governed: false };
  }
  if (policy.ok !== true) {
    return { ok: false, code: 'APPROVAL_RBAC_POLICY_INVALID', message: `approval RBAC policy is invalid: ${policy.reason}` };
  }
  const hashes = policy.policy.operatorApiKeyHashes || {};
  if (Object.keys(hashes).length === 0) {
    const authorized = authorizeApproval({ policy, operatorId: fallbackOperatorId });
    return authorized.ok
      ? { ...authorized, operatorId: fallbackOperatorId || null, source: 'legacy_totp' }
      : authorized;
  }
  if (typeof apiKey !== 'string' || apiKey.length < 32 || apiKey.length > 256 || /\s/.test(apiKey)) {
    return { ok: false, code: 'APPROVAL_RBAC_API_KEY_REQUIRED', message: 'a configured operator API key is required' };
  }
  const actual = crypto.createHash('sha256').update(apiKey, 'utf8').digest();
  let operatorId = null;
  for (const [candidate, hash] of Object.entries(hashes)) {
    const expected = Buffer.from(hash, 'hex');
    if (expected.length === actual.length && crypto.timingSafeEqual(actual, expected)) operatorId = candidate;
  }
  if (!operatorId) {
    return { ok: false, code: 'APPROVAL_RBAC_API_KEY_INVALID', message: 'operator API key is not recognized' };
  }
  const authorized = authorizeApproval({ policy, operatorId });
  return authorized.ok ? { ...authorized, source: 'api_key' } : authorized;
}

function quorumRequiredFor(policy, tool) {
  if (!policy || policy.configured !== true || policy.ok !== true) return 1;
  return policy.policy.quorum.byTool[tool] ?? policy.policy.quorum.default ?? 1;
}

module.exports = {
  RBAC_POLICY_ENV,
  PERMISSIONS,
  ALLOWED_PERMISSIONS,
  loadApprovalRbacPolicy,
  authorizeApproval,
  resolveApprovalOperator,
  quorumRequiredFor,
  validatePolicy,
};
