'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  RELEASE_SECURITY_GROUPS,
  selectedTests,
  validateReleaseSecuritySuite,
} = require('../scripts/security-release-evaluation');

test('release security evaluation has all three required evidence groups and live test files', () => {
  const root = path.resolve(__dirname, '..');
  const result = validateReleaseSecuritySuite(root);
  assert.deepEqual(result.errors, []);
  assert.ok(RELEASE_SECURITY_GROUPS.adversarial.length >= 1);
  assert.ok(RELEASE_SECURITY_GROUPS.jailbreak.length >= 1);
  assert.ok(RELEASE_SECURITY_GROUPS.privilege_overreach.length >= 1);
  assert.equal(result.tests.length, new Set(result.tests).size);
});

test('suite validation fails closed when a required group is empty', () => {
  const root = path.resolve(__dirname, '..');
  const groups = {
    ...RELEASE_SECURITY_GROUPS,
    jailbreak: [],
  };
  const result = validateReleaseSecuritySuite(root, groups);
  assert.ok(result.errors.some((entry) => entry.includes('jailbreak: no tests configured')));
});

test('suite validation rejects missing test references', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-release-security-'));
  const groups = {
    adversarial: ['test/missing-adversarial.test.js'],
    jailbreak: ['test/missing-jailbreak.test.js'],
    privilege_overreach: ['test/missing-overreach.test.js'],
  };
  const result = validateReleaseSecuritySuite(root, groups);
  assert.equal(result.errors.length, 3);
  assert.ok(result.errors.every((entry) => entry.includes('test does not exist')));
});

test('selected test list is deterministic and de-duplicated', () => {
  const groups = {
    adversarial: ['test/a.test.js', 'test/shared.test.js'],
    jailbreak: ['test/shared.test.js', 'test/b.test.js'],
    privilege_overreach: ['test/c.test.js'],
  };
  assert.deepEqual(selectedTests(groups), [
    'test/a.test.js',
    'test/shared.test.js',
    'test/b.test.js',
    'test/c.test.js',
  ]);
});


test('package command and publish workflow keep the release evaluation gate wired', () => {
  const root = path.resolve(__dirname, '..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/publish.yml'), 'utf8');
  assert.equal(packageJson.scripts['test:security-release'], 'node scripts/security-release-evaluation.js');
  assert.match(workflow, /name: Run release security evaluation/);
  assert.match(workflow, /run: npm run test:security-release/);
});
