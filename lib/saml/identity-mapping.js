// SPDX-License-Identifier: LicenseRef-HUQAN-Enterprise
'use strict';

// Identity mapping for SAML logins (#4214).
//
// The SP normalizes the validated SAML subject into the shared principal
// contract that the RBAC policy (lib/approval-rbac.js) already consumes:
// one operatorId per human. The mapping is deliberately narrow:
//
//   - The operatorId comes from exactly one configured source: either the
//     SAML attribute named by HUQAN_SAML_SUBJECT_ATTR (when configured),
//     or the NameID (when it is not).
//   - The operatorId must be a bounded identifier. A NameID that is a
//     URI, an unpadded base64 blob, or anything with whitespace is refused,
//     not normalized: an "identity" the SP cannot bound cannot name an
//     operator, and an operator the RBAC policy does not know is refused
//     there (APPROVAL_RBAC_OPERATOR_UNKNOWN).
//   - No attribute other than the configured one is read. An IdP that sends
//     `role=admin` in an extra attribute grants nothing: the role comes from
//     the local RBAC policy, never from the assertion (issue #4214: "Never
//     infer a privileged role from an unconfigured attribute").
//
// The module exports a pure function so the test can exercise every refusal
// without a server. The session/HTTP layer calls it after the assertion has
// passed validateResponse; a refused mapping never creates a session.

const OPERATOR_ID = /^[A-Za-z0-9_.:@-]{1,128}$/;

const REFUSED = {
  NO_SUBJECT: 'saml_no_subject',
  UNBOUND_SUBJECT: 'saml_unbound_subject',
  MULTIVALUE_ATTRIBUTE: 'saml_multivalue_subject_attribute',
  UNKNOWN_OPERATOR: 'saml_unknown_operator',
  ROLE_NOT_CONFIGURED: 'saml_role_not_configured',
};

/**
 * Map a validated assertion to the principal the RBAC layer expects.
 *
 * @param {object} validated - result of validateResponse (ok: true branch)
 * @param {object} opts
 * @param {string} [opts.subjectAttribute] - SAML attribute name that carries
 *   the operator identity (HUQAN_SAML_SUBJECT_ATTR). When omitted, the NameID
 *   is used.
 * @param {object|null} [opts.rbacPolicy] - the loaded RBAC policy
 *   ({configured, ok, policy} shape from lib/approval-rbac.js). When passed,
 *   the mapping also resolves the role so the session carries it; when
 *   omitted, the mapping only produces the operatorId and leaves the role
 *   to the decision path.
 * @returns {{ok: true, principal: {operatorId, nameId, role: string|null, attributes: object}}
 *   | {ok: false, code: string, message: string}}
 */
function mapSamlPrincipal(validated, opts = {}) {
  if (!validated || validated.ok !== true) {
    return { ok: false, code: REFUSED.NO_SUBJECT, message: 'no validated SAML assertion' };
  }

  const nameId = validated.subject && typeof validated.subject.nameId === 'string'
    ? validated.subject.nameId
    : '';
  if (!nameId) {
    return { ok: false, code: REFUSED.NO_SUBJECT, message: 'assertion has no NameID' };
  }

  // Which field carries the operator identity?
  let operatorId;
  if (typeof opts.subjectAttribute === 'string' && opts.subjectAttribute) {
    const values = validated.attributes && validated.attributes[opts.subjectAttribute];
    if (!Array.isArray(values) || values.length === 0) {
      return { ok: false, code: REFUSED.UNBOUND_SUBJECT,
        message: `assertion does not carry the configured subject attribute ${opts.subjectAttribute}` };
    }
    if (values.length > 1) {
      return { ok: false, code: REFUSED.MULTIVALUE_ATTRIBUTE,
        message: `subject attribute ${opts.subjectAttribute} carries more than one value` };
    }
    operatorId = values[0];
  } else {
    operatorId = nameId;
  }

  if (typeof operatorId !== 'string' || !OPERATOR_ID.test(operatorId)) {
    return { ok: false, code: REFUSED.UNBOUND_SUBJECT,
      message: 'the resolved subject is not a bounded operator identifier' };
  }

  // Role: only from the local RBAC policy, never from the assertion.
  // The caller passes the lib/approval-rbac.js result ({configured, ok, policy}).
  // When no policy is configured the mapping only produces the operatorId and
  // the decision path enforces authority later.
  let role = null;
  const raw = opts.rbacPolicy;
  const policy = raw && raw.configured === true && raw.ok === true
    ? raw.policy
    : (raw && raw.operators && raw.roles ? raw : null);
  if (policy) {
    const known = Object.prototype.hasOwnProperty.call(policy.operators, operatorId);
    if (!known) {
      return { ok: false, code: REFUSED.UNKNOWN_OPERATOR,
        message: `operator ${operatorId} has no role in the RBAC policy` };
    }
    role = policy.operators[operatorId];
    // The role must grant at least approvals.view; a role with no read
    // permission would log a user in who cannot see anything. (admin /
    // approver / operator all carry view in the shipped policy.)
    if (!Array.isArray(policy.roles[role]) || policy.roles[role].indexOf('approvals.view') < 0) {
      return { ok: false, code: REFUSED.ROLE_NOT_CONFIGURED,
        message: `role ${role} grants no viewer permission` };
    }
  }

  return {
    ok: true,
    principal: Object.freeze({
      operatorId,
      nameId,
      role,
      attributes: validated.attributes,
    }),
  };
}

module.exports = {
  OPERATOR_ID,
  REFUSED,
  mapSamlPrincipal,
};
