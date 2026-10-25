'use strict';

// Identity mapping for OIDC logins (#4267; contract in docs/sso.md).
//
// The RP normalizes a validated ID token into the shared principal contract
// the RBAC policy (lib/approval-rbac.js) already consumes: one operatorId per
// human. The mapping is deliberately narrow:
//
//   - operatorId = 'oidc:' + base64url(SHA-256(issuer + NUL + sub)). The
//     subject claim is fixed to `sub`; email is never the key, because it can
//     change and be reassigned.
//   - The role comes from exactly one configured group claim in the validated
//     token. A group with no mapping is denied (never a default role), and two
//     groups that map to different roles are denied.
//   - The role must exist in the local RBAC vocabulary; a mapped role the
//     policy does not know is denied rather than invented.
//
// The module exports pure functions so a test can exercise every refusal
// without a server or a provider.

const crypto = require('node:crypto');

const MAPPING_VERSION = 1;
const OPERATOR_ID = /^[A-Za-z0-9_.:@-]{1,128}$/;
const MAX_GROUPS = 256;
const MAX_GROUP_LENGTH = 256;
const MAX_CLAIM_LENGTH = 4096;

const REFUSED = Object.freeze({
  NO_SUBJECT: 'oidc_no_subject',
  UNBOUND_SUBJECT: 'oidc_unbound_subject',
  OVERSIZED_CLAIM: 'oidc_oversized_claim',
  MISSING_GROUP: 'oidc_missing_group_mapping',
  UNKNOWN_ROLE: 'oidc_unknown_role',
  ROLE_CONFLICT: 'oidc_role_conflict',
});

function deny(code, message) {
  return { ok: false, code, message };
}

/**
 * The stable operator id: `oidc:` plus base64url(SHA-256(issuer NUL sub)).
 * Deterministic, so the same person at the same issuer yields the same id on
 * every deployment and in every test vector.
 */
function deriveOperatorId(issuer, sub) {
  const digest = crypto.createHash('sha256')
    .update(String(issuer), 'utf8')
    .update(Buffer.from([0]))
    .update(String(sub), 'utf8')
    .digest('base64url');
  return `oidc:${digest}`;
}

function validateMapping(mapping) {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    return deny(REFUSED.MISSING_GROUP, 'identity mapping must be a JSON object');
  }
  if (mapping.version !== MAPPING_VERSION) {
    return deny(REFUSED.MISSING_GROUP, `identity mapping version must be ${MAPPING_VERSION}`);
  }
  if (mapping.operatorIdStrategy !== 'issuer-sub-sha256') {
    return deny(REFUSED.UNBOUND_SUBJECT, 'the only supported operatorIdStrategy is issuer-sub-sha256');
  }
  if (typeof mapping.groupsClaim !== 'string' || !mapping.groupsClaim) {
    return deny(REFUSED.MISSING_GROUP, 'identity mapping must name its groupsClaim');
  }
  // The subject claim is fixed. A mapping that tries to select another one is
  // refused rather than ignored, because ignoring it would silently accept a
  // weaker principal key than the contract states.
  if (Object.prototype.hasOwnProperty.call(mapping, 'subjectClaim')) {
    return deny(REFUSED.UNBOUND_SUBJECT, 'the subject claim is fixed to sub and is not configurable');
  }
  if (!mapping.groupRoles || typeof mapping.groupRoles !== 'object' || Array.isArray(mapping.groupRoles)) {
    return deny(REFUSED.MISSING_GROUP, 'identity mapping must carry a groupRoles object');
  }
  if (mapping.unmappedGroupPolicy !== 'deny') {
    return deny(REFUSED.MISSING_GROUP, 'unmappedGroupPolicy must be deny');
  }
  if (mapping.roleConflictPolicy !== 'deny') {
    return deny(REFUSED.ROLE_CONFLICT, 'roleConflictPolicy must be deny');
  }
  return { ok: true };
}

function readGroups(claims, groupsClaim) {
  const raw = claims[groupsClaim];
  if (raw === undefined || raw === null) return { ok: true, groups: [] };
  const values = Array.isArray(raw) ? raw : [raw];
  if (values.length > MAX_GROUPS) return deny(REFUSED.OVERSIZED_CLAIM, 'the group claim carries too many values');
  const groups = [];
  for (const value of values) {
    if (typeof value !== 'string') return deny(REFUSED.OVERSIZED_CLAIM, 'the group claim must carry strings');
    if (value.length === 0 || value.length > MAX_GROUP_LENGTH) {
      return deny(REFUSED.OVERSIZED_CLAIM, 'a group value is empty or too long');
    }
    groups.push(value);
  }
  return { ok: true, groups };
}

/**
 * Map a validated ID token into the principal the RBAC layer expects.
 *
 * @param {object} claims - the validated ID-token claims
 * @param {object} opts
 * @param {object} opts.mapping - the identity mapping
 * @param {string} opts.issuer - the exact configured issuer
 * @param {object|null} [opts.rbacPolicy] - the loaded RBAC policy
 *   ({configured, ok, policy}); when passed, the mapped role is also required
 *   to exist in the policy vocabulary.
 * @returns {{ok: true, principal: {operatorId, subject, role}}
 *   | {ok: false, code: string, message: string}}
 */
function mapOidcPrincipal(claims, opts = {}) {
  const mapping = opts.mapping;
  const valid = validateMapping(mapping);
  if (!valid.ok) return valid;

  if (!claims || typeof claims !== 'object') return deny(REFUSED.NO_SUBJECT, 'no validated ID-token claims');
  const sub = claims.sub;
  if (typeof sub !== 'string' || sub.length === 0) return deny(REFUSED.NO_SUBJECT, 'the ID token has no sub claim');
  if (sub.length > MAX_CLAIM_LENGTH) return deny(REFUSED.OVERSIZED_CLAIM, 'the sub claim is too long');

  const operatorId = deriveOperatorId(opts.issuer, sub);
  if (!OPERATOR_ID.test(operatorId)) return deny(REFUSED.UNBOUND_SUBJECT, 'the derived operator id is not bounded');

  const groups = readGroups(claims, mapping.groupsClaim);
  if (!groups.ok) return groups;

  const mappedRoles = new Set();
  for (const group of groups.groups) {
    if (!Object.prototype.hasOwnProperty.call(mapping.groupRoles, group)) {
      return deny(REFUSED.MISSING_GROUP, `group ${group} has no configured role mapping`);
    }
    mappedRoles.add(mapping.groupRoles[group]);
  }
  if (mappedRoles.size === 0) return deny(REFUSED.MISSING_GROUP, 'the ID token carries no mapped group');
  if (mappedRoles.size > 1) return deny(REFUSED.ROLE_CONFLICT, 'the ID token maps to more than one role');

  const role = [...mappedRoles][0];
  const policy = opts.rbacPolicy;
  const knownRoles = policy && policy.configured === true && policy.ok === true
    ? policy.policy.roles
    : null;
  if (knownRoles && !Object.prototype.hasOwnProperty.call(knownRoles, role)) {
    return deny(REFUSED.UNKNOWN_ROLE, `role ${role} is not in the RBAC policy vocabulary`);
  }

  return { ok: true, principal: Object.freeze({ operatorId, subject: sub, role }) };
}

module.exports = {
  MAPPING_VERSION,
  OPERATOR_ID,
  REFUSED,
  deriveOperatorId,
  validateMapping,
  mapOidcPrincipal,
};
