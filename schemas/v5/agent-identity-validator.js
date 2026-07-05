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

function validateRevokedShape(fixture, errors) {
  if (fixture.expected_reason_code !== 'identity_revoked') {
    return;
  }

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
  if (fixture.expected_reason_code !== 'identity_expired') {
    return;
  }

  if (!hasNonEmptyString(fixture.expires_at)) {
    errors.push(makeError('expires_at_required', '/expires_at', 'Expired fixture must include expires_at.'));
  }
}

function validateWorkspaceMismatchShape(fixture, errors) {
  if (fixture.expected_reason_code !== 'workspace_mismatch') {
    return;
  }

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

function validateBrokenDelegationShape(fixture, errors) {
  if (fixture.expected_reason_code !== 'broken_delegation_chain') {
    return;
  }

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
  validateRevokedShape(fixture, errors);
  validateExpiredShape(fixture, errors);
  validateWorkspaceMismatchShape(fixture, errors);
  validateBrokenDelegationShape(fixture, errors);

  return {
    valid: errors.length === 0,
    errors
  };
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
