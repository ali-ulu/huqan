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

const fs = require('node:fs');
const { readCompatibleEnvironmentVariable } = require('./environment-compat');

const RBAC_POLICY_ENV = 'RBAC_POLICY_PATH';
const POLICY_VERSION = 1;
const PERMISSIONS = Object.freeze({
  VIEW: 'approvals.view',
  DECIDE: 'approvals.decide',
  MANAGE: 'approvals.manage',
});
const ALLOWED_PERMISSIONS = Object.freeze(Object.values(PERMISSIONS));
const POLICY_FIELDS = Object.freeze(['version', 'roles', 'operators', 'separationOfDuties']);
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

  return {
    configured: true,
    ok: true,
    policy: Object.freeze({
      version: POLICY_VERSION,
      roles: Object.freeze(roles),
      operators: Object.freeze(operators),
      separationOfDuties: value.separationOfDuties === true,
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

module.exports = {
  RBAC_POLICY_ENV,
  PERMISSIONS,
  ALLOWED_PERMISSIONS,
  loadApprovalRbacPolicy,
  authorizeApproval,
  validatePolicy,
};
