const fs = require('node:fs');
const path = require('node:path');
const { validateAgentIdentityFixture } = require('./agent-identity-validator');

const INVALID_EXPECTED_STATUSES = new Set([
  'invalid',
  'revoked',
  'expired',
  'rejected'
]);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function listFixtureFiles(fixturesDir) {
  return fs.readdirSync(fixturesDir)
    .filter((name) => name.endsWith('.json'))
    .sort();
}

function hasStructuredErrors(errors) {
  return Array.isArray(errors) && errors.every((error) => (
    error &&
    typeof error.code === 'string' &&
    error.code.trim() !== '' &&
    typeof error.path === 'string' &&
    error.path.trim() !== '' &&
    typeof error.message === 'string' &&
    error.message.trim() !== ''
  ));
}

function hasErrorCode(errors, code) {
  return Array.isArray(errors) && errors.some((error) => error.code === code);
}

function expectedReasonIsPresent(fixture) {
  if (fixture.expected_status === 'valid') {
    return fixture.expected_reason_code === null;
  }

  return typeof fixture.expected_reason_code === 'string' && fixture.expected_reason_code.trim() !== '';
}

/**
 * A declared reason code the validator does not recognize.
 *
 * Without this, a misspelled discriminator still conformed: the declared code
 * is echoed into errors by validateExpectedInvalidState, so
 * hasErrorCode(errors, expected_reason_code) matched the typo itself while
 * every shape rule keyed on that code had been skipped (#1537). The check that
 * was supposed to prove the fixture encodes its violation instead proved only
 * that it names one.
 */
function hasUnusableReasonCode(errors) {
  return hasErrorCode(errors, 'unknown_reason_code') || hasErrorCode(errors, 'enum_value_not_allowed');
}

function isInvalidFixtureConformant(fixture, validation) {
  return validation.valid === false &&
    INVALID_EXPECTED_STATUSES.has(fixture.expected_status) &&
    expectedReasonIsPresent(fixture) &&
    hasStructuredErrors(validation.errors) &&
    !hasUnusableReasonCode(validation.errors) &&
    hasErrorCode(validation.errors, fixture.expected_reason_code);
}

function isValidFixtureConformant(fixture, validation) {
  return fixture.expected_status === 'valid' &&
    fixture.expected_reason_code === null &&
    validation.valid === true &&
    Array.isArray(validation.errors) &&
    validation.errors.length === 0;
}

function buildResult(file, fixture, validation) {
  const conformanceValid = isValidFixtureConformant(fixture, validation) ||
    isInvalidFixtureConformant(fixture, validation);

  return {
    file,
    expected_status: fixture.expected_status,
    expected_reason_code: fixture.expected_reason_code,
    validator_valid: validation.valid,
    conformance_valid: conformanceValid,
    errors: validation.errors
  };
}

function runAgentIdentityConformance(options = {}) {
  const { fixturesDir, schemaPath } = options;

  if (typeof fixturesDir !== 'string' || fixturesDir.trim() === '') {
    throw new TypeError('fixturesDir is required');
  }

  if (typeof schemaPath !== 'string' || schemaPath.trim() === '') {
    throw new TypeError('schemaPath is required');
  }

  const schema = readJson(schemaPath);
  const fixtureFiles = listFixtureFiles(fixturesDir);
  const results = fixtureFiles.map((file) => {
    const fixturePath = path.join(fixturesDir, file);
    const fixture = readJson(fixturePath);
    const validation = validateAgentIdentityFixture(fixture, schema);

    return buildResult(file, fixture, validation);
  });
  const passed = results.filter((result) => result.conformance_valid).length;
  const failed = results.length - passed;

  return {
    ok: failed === 0,
    schemaPath,
    fixturesDir,
    totalFixtures: results.length,
    passed,
    failed,
    results
  };
}

function summarizeAgentIdentityConformance(results) {
  const resultList = Array.isArray(results) ? results : [];
  const passed = resultList.filter((result) => result.conformance_valid).length;
  const failed = resultList.length - passed;

  return {
    ok: failed === 0,
    totalFixtures: resultList.length,
    passed,
    failed,
    failingFiles: resultList
      .filter((result) => !result.conformance_valid)
      .map((result) => result.file)
  };
}

module.exports = {
  runAgentIdentityConformance,
  summarizeAgentIdentityConformance
};
