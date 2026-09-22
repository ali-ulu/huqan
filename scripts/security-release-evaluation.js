'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RELEASE_SECURITY_GROUPS = Object.freeze({
  adversarial: Object.freeze([
    'test/external-client-route-adversarial.test.js',
    'test/production-http-adversarial.test.js',
    'test/verify-adversarial.integration.test.js',
  ]),
  jailbreak: Object.freeze([
    'kernel.v2.test.js',
    'mcpServer.test.js',
    'test/refactor-2e-learn-memory-admission-contract.test.js',
  ]),
  privilege_overreach: Object.freeze([
    'test/identity-privilege-escalation.test.js',
    'test/identity-privilege-escalation-guard-wiring.test.js',
    'test/mcp-security-integration-regression-matrix.test.js',
    'test/sandbox-host-realm-escape.test.js',
    'test/unexpected-egress-guard-wiring.test.js',
  ]),
});

function selectedTests(groups = RELEASE_SECURITY_GROUPS) {
  return [...new Set(Object.values(groups).flat())];
}

function validateReleaseSecuritySuite(rootDir = path.resolve(__dirname, '..'), groups = RELEASE_SECURITY_GROUPS) {
  const errors = [];
  for (const required of ['adversarial', 'jailbreak', 'privilege_overreach']) {
    const files = groups[required];
    if (!Array.isArray(files) || files.length === 0) {
      errors.push(`${required}: no tests configured`);
      continue;
    }
    for (const file of files) {
      if (typeof file !== 'string' || (!file.endsWith('.test.js') && !file.endsWith('.integration.test.js'))) {
        errors.push(`${required}: invalid test reference ${String(file)}`);
        continue;
      }
      const absolute = path.resolve(rootDir, file);
      const relative = path.relative(rootDir, absolute);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        errors.push(`${required}: test escapes repository root: ${file}`);
        continue;
      }
      if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
        errors.push(`${required}: test does not exist: ${file}`);
      }
    }
  }
  return { errors, tests: selectedTests(groups) };
}

function main() {
  const rootDir = path.resolve(__dirname, '..');
  const validation = validateReleaseSecuritySuite(rootDir);
  if (validation.errors.length > 0) {
    for (const error of validation.errors) console.error(`FAIL release security evaluation: ${error}`);
    return 1;
  }

  console.log(
    `Release security evaluation: ${validation.tests.length} tests across adversarial, jailbreak and privilege-overreach groups.`,
  );
  const result = spawnSync(
    process.execPath,
    [
      path.join(rootDir, 'scripts/run-tests.js'),
      '--test-concurrency=1',
      ...validation.tests,
    ],
    {
      cwd: rootDir,
      env: { ...process.env, HUQAN_RELEASE_SECURITY_EVALUATION: '1' },
      stdio: 'inherit',
    },
  );

  if (result.error) {
    console.error(`FAIL release security evaluation: ${result.error.message}`);
    return 1;
  }
  return Number.isInteger(result.status) ? result.status : 1;
}

if (require.main === module) process.exitCode = main();

module.exports = {
  RELEASE_SECURITY_GROUPS,
  selectedTests,
  validateReleaseSecuritySuite,
};
