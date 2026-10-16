const fs = require('node:fs');

function makeError(code, path, message) {
  return { code, path, message };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function validateEnumField(fixture, schema, field, errors) {
  if (!Object.hasOwn(fixture, field)) {
    return;
  }

  const allowed = schema.properties?.[field]?.enum;
  if (!Array.isArray(allowed)) {
    return;
  }

  if (!allowed.includes(fixture[field])) {
    errors.push(makeError(
      'enum_value_not_allowed',
      `/${field}`,
      `${field} must be one of: ${allowed.join(', ')}`
    ));
  }
}

function validateExpectedInvalidState(fixture, errors) {
  if (fixture.expected_status === 'valid') {
    return;
  }

  const reasonCode = fixture.expected_reason_code || 'expected_invalid_fixture';
  errors.push(makeError(
    reasonCode,
    '/expected_reason_code',
    `Fixture declares expected invalid status: ${fixture.expected_status}`
  ));
}

// The reason-code gate that used to open each of these lives in
// REASON_CODE_SHAPES now, so the discriminator is tested once instead of ten
// times and an unmatched code is an error rather than nine silent returns.
function validateRevokedShape(fixture, errors) {
  if (!hasNonEmptyString(fixture.revoked_at)) {
    errors.push(makeError('revoked_at_required', '/revoked_at', 'Revoked fixture must include revoked_at.'));
  }

  if (!hasNonEmptyString(fixture.revocation_reason)) {
    errors.push(makeError(
      'revocation_reason_required',
      '/revocation_reason',
      'Revoked fixture must include revocation_reason.'
    ));
  }
}

function validateExpiredShape(fixture, errors) {
  if (!hasNonEmptyString(fixture.expires_at)) {
    errors.push(makeError('expires_at_required', '/expires_at', 'Expired fixture must include expires_at.'));
  }
}

function validateWorkspaceMismatchShape(fixture, errors) {
  if (!hasNonEmptyString(fixture.requested_workspace_id)) {
    errors.push(makeError(
      'requested_workspace_id_required',
      '/requested_workspace_id',
      'Workspace mismatch fixture must include requested_workspace_id.'
    ));
    return;
  }

  if (fixture.requested_workspace_id === fixture.workspace_id) {
    errors.push(makeError(
      'workspace_mismatch_not_encoded',
      '/requested_workspace_id',
      'Workspace mismatch fixture must use a requested workspace different from workspace_id.'
    ));
  }
}

// Gate 7 fixture classes (remaining §2.1 rows, added after PR #904):
// Fail-closed — active only when the fixture declares the matching reason code;
// existing fixtures keep their assertions untouched (no shape change below).
function validateIdentityClaimShape(fixture, errors) {
  if (fixture.agent_id !== null) {
    errors.push(makeError(
      'identity_claim_present',
      '/agent_id',
      'Invalid-claim fixture must leave agent_id null.'
    ));
  }

  if (fixture.verification_status !== 'invalid') {
    errors.push(makeError(
      'invalid_claim_status_required',
      '/verification_status',
      'Invalid-claim fixture must assert verification_status invalid.'
    ));
  }
}

function validateDelegationScopeExceededShape(fixture, errors) {
  if (!Array.isArray(fixture.delegation_scope) || !fixture.delegation_scope.includes('invoke')) {
    errors.push(makeError(
      'scope_exceeded_invoke_required',
      '/delegation_scope',
      'Scope-exceeded fixture must carry invoke in delegation_scope.'
    ));
    return;
  }

  if (fixture.trust_tier !== 'probationary' && fixture.trust_tier !== 'unverified') {
    errors.push(makeError(
      'scope_exceeded_trust_floor',
      '/trust_tier',
      'Scope-exceeded fixture must sit below the invoke trust floor.'
    ));
  }
}

function validateDelegationChainInvalidShape(fixture, errors) {
  if (!hasNonEmptyString(fixture.parent_agent_id)) {
    errors.push(makeError(
      'chain_invalid_parent_required',
      '/parent_agent_id',
      'Chain-invalid fixture must include parent_agent_id.'
    ));
    return;
  }

  if (!Array.isArray(fixture.delegation_chain) || fixture.delegation_chain.length === 0) {
    errors.push(makeError(
      'chain_invalid_chain_required',
      '/delegation_chain',
      'Chain-invalid fixture must include delegation_chain entries.'
    ));
    return;
  }

  if (fixture.delegation_chain.includes(fixture.parent_agent_id)) {
    errors.push(makeError(
      'chain_invalid_parent_encoded',
      '/delegation_chain',
      'Chain-invalid fixture must not resolve its parent in the chain.'
    ));
  }
}

function validateConnectorContextShape(fixture, errors) {
  if (!Array.isArray(fixture.allowed_connectors) || fixture.allowed_connectors.length > 0) {
    errors.push(makeError(
      'connector_context_no_connectors',
      '/allowed_connectors',
      'Connector-context fixture must carry an empty allowed_connectors list.'
    ));
  }
}

function validateLifecycleUnresolvableShape(fixture, errors) {
  if (fixture.verification_status !== 'unverified') {
    errors.push(makeError(
      'lifecycle_unresolved_status_required',
      '/verification_status',
      'Unresolvable-lifecycle fixture must assert verification_status unverified.'
    ));
    return;
  }

  if (hasNonEmptyString(fixture.revoked_at) || hasNonEmptyString(fixture.expires_at)) {
    errors.push(makeError(
      'lifecycle_unresolved_no_resolved_events',
      '/revoked_at',
      'Unresolvable-lifecycle fixture must not carry resolved lifecycle events.'
    ));
  }
}

function validateBrokenDelegationShape(fixture, errors) {
  if (!hasNonEmptyString(fixture.parent_agent_id)) {
    errors.push(makeError(
      'parent_agent_id_required',
      '/parent_agent_id',
      'Broken delegation fixture must include parent_agent_id.'
    ));
  }

  if (!Array.isArray(fixture.delegation_chain) || fixture.delegation_chain.length === 0) {
    errors.push(makeError(
      'delegation_chain_required',
      '/delegation_chain',
      'Broken delegation fixture must include delegation_chain entries.'
    ));
    return;
  }

  if (fixture.delegation_chain[0] === fixture.parent_agent_id) {
    errors.push(makeError(
      'broken_delegation_chain_not_encoded',
      '/delegation_chain/0',
      'Broken delegation fixture must encode a chain that does not match parent_agent_id.'
    ));
  }
}

function validateAgentIdentityFixture(fixture, schema) {
  const errors = [];

  if (!isObject(fixture)) {
    return {
      valid: false,
      errors: [makeError('invalid_fixture_object', '/', 'Agent identity fixture must be an object.')]
    };
  }

  if (!isObject(schema) || !isObject(schema.properties) || !Array.isArray(schema.required)) {
    return {
      valid: false,
      errors: [makeError('invalid_schema_object', '/', 'Agent identity schema must declare required and properties.')]
    };
  }

  const schemaFields = new Set(Object.keys(schema.properties));

  for (const field of schema.required) {
    if (!Object.hasOwn(fixture, field)) {
      errors.push(makeError('missing_required_field', `/${field}`, `${field} is required by schema.`));
    }
  }

  for (const field of Object.keys(fixture)) {
    if (!schemaFields.has(field)) {
      errors.push(makeError('unknown_field', `/${field}`, `${field} is not covered by schema properties.`));
    }
  }

  validateEnumField(fixture, schema, 'trust_tier', errors);
  validateEnumField(fixture, schema, 'verification_status', errors);
  // #1537: every shape rule below is gated on expected_reason_code, and this
  // field had no enum at all -- so a one-character typo in the discriminator
  // turned all ten validators off at once and the fixture came back looking
  // like a correctly-written one. expected_status gates
  // validateExpectedInvalidState the same way.
  validateEnumField(fixture, schema, 'expected_reason_code', errors);
  validateEnumField(fixture, schema, 'expected_status', errors);

  if (!Object.hasOwn(fixture, 'expected_status')) {
    errors.push(makeError('missing_expected_status', '/expected_status', 'expected_status is required.'));
  }

  if (!Object.hasOwn(fixture, 'expected_reason_code')) {
    errors.push(makeError(
      'missing_expected_reason_code',
      '/expected_reason_code',
      'expected_reason_code is required and may be null only when schema permits null.'
    ));
  }

  validateExpectedInvalidState(fixture, errors);
  validateReasonCodeShape(fixture, errors);

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Which shape validator owns each reason code.
 *
 * The validators used to be called one after another, each re-testing
 * expected_reason_code and returning silently when it did not match. That made
 * "this code has no rules" and "this code is misspelled" the same event, and
 * the silent one was the fail-open one (#1537). A code that reaches here and is
 * not in this table is named as such instead.
 *
 * `null` means the code is known and carries no extra shape rules of its own --
 * missing_agent_id is covered by the schema's required-field check.
 */
const REASON_CODE_SHAPES = Object.freeze({
  missing_agent_id: null,
  identity_revoked: validateRevokedShape,
  identity_expired: validateExpiredShape,
  workspace_mismatch: validateWorkspaceMismatchShape,
  'identity.invalid_claim': validateIdentityClaimShape,
  'delegation.scope_exceeded': validateDelegationScopeExceededShape,
  'delegation.chain_invalid': validateDelegationChainInvalidShape,
  'connector.context_invalid': validateConnectorContextShape,
  'lifecycle.unresolved': validateLifecycleUnresolvableShape,
  broken_delegation_chain: validateBrokenDelegationShape,
});

function validateReasonCodeShape(fixture, errors) {
  const reasonCode = fixture.expected_reason_code;
  // A valid-class fixture declares no reason code; that is not an unknown one.
  if (reasonCode === null || reasonCode === undefined) {
    return;
  }

  if (!Object.hasOwn(REASON_CODE_SHAPES, reasonCode)) {
    errors.push(makeError(
      'unknown_reason_code',
      '/expected_reason_code',
      `expected_reason_code ${String(reasonCode)} has no shape rules; a misspelled code silently disables every shape check.`
    ));
    return;
  }

  const validator = REASON_CODE_SHAPES[reasonCode];
  if (validator) {
    validator(fixture, errors);
  }
}

function validateAgentIdentityFixtureFile(filePath, schemaPath) {
  try {
    const schema = readJson(schemaPath);
    const fixture = readJson(filePath);
    return validateAgentIdentityFixture(fixture, schema);
  } catch (error) {
    return {
      valid: false,
      errors: [makeError('fixture_read_error', '/', error.message)]
    };
  }
}

module.exports = {
  validateAgentIdentityFixture,
  validateAgentIdentityFixtureFile
};
