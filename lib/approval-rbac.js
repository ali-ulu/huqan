'use strict';

// Approval RBAC (#4205, slice of #ENT-RBAC).
//
// Opt-in: with no policy configured the single-user installation behaves
// exactly as before. Once HUQAN_RBAC_POLICY_PATH names a policy, the policy is
// authoritative. An unreadable or malformed policy refuses every decision.
// If per-operator verifiers are configured, a key must verify for its hinted
// operator id; otherwise the configured legacy operator id/TOTP path applies.
// Caller-supplied identity strings alone never grant a role.
//
// The policy is local configuration, not a signed document. It maps the
// identity the approval authority asserts in the signed decision envelope
// (lib/authority/decision-envelope.js) to a role. Protecting the file is the
// deployment's job. SSO (#4204) will change where the authority learns the
// identity, not this mapping.

const crypto = require('node:crypto');
const fs = require('node:fs');
const { readCompatibleEnvironmentVariable } = require('./environment-compat');
const { hashCanonicalPayload } = require('./hash-chain');

const RBAC_POLICY_ENV = 'RBAC_POLICY_PATH';
const POLICY_VERSION = 1;
const API_KEY = /^[A-Za-z0-9_-]{32,256}$/;
const API_KEY_SALT = /^[A-Za-z0-9_-]{22}$/;
const API_KEY_VERIFIER = /^[A-Za-z0-9_-]{43}$/;
const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const MAX_QUORUM = 16;
const PERMISSIONS = Object.freeze({
  VIEW: 'approvals.view',
  DECIDE: 'approvals.decide',
  MANAGE: 'approvals.manage',
});
const ALLOWED_PERMISSIONS = Object.freeze(Object.values(PERMISSIONS));
const POLICY_FIELDS = Object.freeze(['version', 'roles', 'operators', 'separationOfDuties', 'operatorApiKeySalt', 'operatorApiKeyVerifiers', 'quorum']);
const OPERATOR_ID = /^[A-Za-z0-9_.:@-]{1,128}$/;
const MAX_ROLE = 64;

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalid(reason) {
  return { configured: true, ok: false, reason };
}

/**
 * A canonical digest of the policy that governed a decision (#4215). The
 * decision envelope and every durable vote carry it, so an auditor can tell
 * which verifier set and threshold produced an approval even after the local
 * policy file changed. It covers the whole effective policy, including the
 * scrypt verifiers (already non-secret) and the quorum thresholds; the raw API
 * keys are never part of the policy and never reach this hash.
 */
function policyHashFor(policy) {
  return hashCanonicalPayload({
    version: policy.version,
    roles: policy.roles,
    operators: policy.operators,
    separationOfDuties: policy.separationOfDuties,
    operatorApiKeySalt: policy.operatorApiKeySalt,
    operatorApiKeyVerifiers: policy.operatorApiKeyVerifiers,
    quorum: policy.quorum,
  });
}

function createOperatorApiKeySalt() {
  return crypto.randomBytes(16).toString('base64url');
}

function createOperatorApiKeyVerifier(apiKey, salt) {
  if (typeof apiKey !== 'string' || !API_KEY.test(apiKey)) {
    throw new TypeError('operator API keys must be 32-256 base64url characters');
  }
  if (typeof salt !== 'string' || !API_KEY_SALT.test(salt)) {
    throw new TypeError('operator API-key salt must be 16 random bytes encoded as base64url');
  }
  const saltBytes = Buffer.from(salt, 'base64url');
  if (saltBytes.length !== 16) throw new TypeError('operator API-key salt must decode to 16 bytes');
  return crypto.scryptSync(apiKey, saltBytes, 32, SCRYPT).toString('base64url');
}

function verifyOperatorApiKey(apiKey, salt, verifier) {
  if (typeof apiKey !== 'string' || !API_KEY.test(apiKey)
      || typeof salt !== 'string' || !API_KEY_SALT.test(salt)
      || typeof verifier !== 'string' || !API_KEY_VERIFIER.test(verifier)) return false;
  const saltBytes = Buffer.from(salt, 'base64url');
  const expected = Buffer.from(verifier, 'base64url');
  if (saltBytes.length !== 16 || expected.length !== 32) return false;
  const actual = crypto.scryptSync(apiKey, saltBytes, 32, SCRYPT);
  return crypto.timingSafeEqual(actual, expected);
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

  if (value.operatorApiKeyVerifiers !== undefined && !plain(value.operatorApiKeyVerifiers)) {
    return invalid('operatorApiKeyVerifiers must map operatorId to a scrypt verifier');
  }
  const operatorApiKeyVerifiers = {};
  const uniqueVerifiers = new Set();
  const rawVerifiers = value.operatorApiKeyVerifiers || {};
  const operatorApiKeySalt = value.operatorApiKeySalt;
  if (Object.keys(rawVerifiers).length > 0 && (typeof operatorApiKeySalt !== 'string'
      || !API_KEY_SALT.test(operatorApiKeySalt) || Buffer.from(operatorApiKeySalt, 'base64url').length !== 16)) {
    return invalid('operatorApiKeySalt must be 16 random bytes encoded as base64url when API-key verifiers are configured');
  }
  if (operatorApiKeySalt !== undefined && (typeof operatorApiKeySalt !== 'string'
      || !API_KEY_SALT.test(operatorApiKeySalt) || Buffer.from(operatorApiKeySalt, 'base64url').length !== 16)) {
    return invalid('operatorApiKeySalt must be 16 random bytes encoded as base64url');
  }
  for (const [operatorId, verifier] of Object.entries(rawVerifiers)) {
    if (!Object.prototype.hasOwnProperty.call(operators, operatorId)) {
      return invalid(`API key verifier names unknown operator ${operatorId}`);
    }
    if (!roles[operators[operatorId]].includes(PERMISSIONS.DECIDE)) {
      return invalid(`API key operator ${operatorId} must have approvals.decide`);
    }
    if (typeof verifier !== 'string' || !API_KEY_VERIFIER.test(verifier)
        || Buffer.from(verifier, 'base64url').length !== 32) {
      return invalid(`API key verifier for ${operatorId} must be a 32-byte base64url scrypt result`);
    }
    if (uniqueVerifiers.has(verifier)) return invalid('operator API key verifiers must be unique');
    uniqueVerifiers.add(verifier);
    operatorApiKeyVerifiers[operatorId] = verifier;
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
  if (maxThreshold > 1 && Object.keys(operatorApiKeyVerifiers).length < maxThreshold) {
    return invalid('quorum above one requires at least N distinct operator API-key verifiers with approvals.decide');
  }

  const policy = {
    version: POLICY_VERSION,
    roles: Object.freeze(roles),
    operators: Object.freeze(operators),
    separationOfDuties: value.separationOfDuties === true,
    operatorApiKeySalt: operatorApiKeySalt || null,
    operatorApiKeyVerifiers: Object.freeze(operatorApiKeyVerifiers),
    quorum: Object.freeze({ default: defaultQuorum, byTool: Object.freeze(byTool) }),
  };
  return {
    configured: true,
    ok: true,
    policy: Object.freeze({ ...policy, hash: policyHashFor(policy) }),
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
      message: 'approval RBAC policy is configured but no valid operator identity was resolved' };
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

function resolveApprovalOperator({ policy, apiKey, operatorIdHint, fallbackOperatorId, requesterId } = {}) {
  if (!policy || policy.configured !== true) {
    return { ok: true, operatorId: fallbackOperatorId || null, source: 'legacy_totp', governed: false };
  }
  if (policy.ok !== true) {
    return { ok: false, code: 'APPROVAL_RBAC_POLICY_INVALID', message: `approval RBAC policy is invalid: ${policy.reason}` };
  }
  const verifiers = policy.policy.operatorApiKeyVerifiers || {};
  if (Object.keys(verifiers).length === 0) {
    const authorized = authorizeApproval({ policy, operatorId: fallbackOperatorId, requesterId });
    return authorized.ok
      ? { ...authorized, operatorId: fallbackOperatorId || null, source: 'legacy_totp' }
      : authorized;
  }
  if (typeof apiKey !== 'string' || !API_KEY.test(apiKey)) {
    return { ok: false, code: 'APPROVAL_RBAC_API_KEY_REQUIRED', message: 'a configured operator API key is required' };
  }
  if (typeof operatorIdHint !== 'string' || !OPERATOR_ID.test(operatorIdHint)) {
    return { ok: false, code: 'APPROVAL_RBAC_OPERATOR_REQUIRED', message: 'a configured operator id hint is required with this API key' };
  }
  const verifier = verifiers[operatorIdHint];
  if (!verifier || !verifyOperatorApiKey(apiKey, policy.policy.operatorApiKeySalt, verifier)) {
    return { ok: false, code: 'APPROVAL_RBAC_API_KEY_INVALID', message: 'operator API key is not recognized for the requested identity' };
  }
  const authorized = authorizeApproval({ policy, operatorId: operatorIdHint, requesterId });
  return authorized.ok ? { ...authorized, source: 'api_key' } : authorized;
}

function quorumRequiredFor(policy, tool) {
  if (!policy || policy.configured !== true || policy.ok !== true) return 1;
  return policy.policy.quorum.byTool[tool] ?? policy.policy.quorum.default ?? 1;
}

/**
 * The non-secret fields a decision and each vote carry so a later policy edit
 * cannot be read back onto an earlier approval (#4215). No policy configured
 * means no fields, exactly as before.
 */
function policyFingerprint(policy) {
  if (!policy || policy.configured !== true || policy.ok !== true) return {};
  return { policyVersion: policy.policy.version, policyHash: policy.policy.hash };
}

module.exports = {
  RBAC_POLICY_ENV,
  PERMISSIONS,
  ALLOWED_PERMISSIONS,
  loadApprovalRbacPolicy,
  authorizeApproval,
  resolveApprovalOperator,
  quorumRequiredFor,
  policyFingerprint,
  policyHashFor,
  createOperatorApiKeySalt,
  createOperatorApiKeyVerifier,
  validatePolicy,
};
