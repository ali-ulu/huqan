'use strict';

/**
 * The required-checks gate must not claim a verdict it cannot reach.
 *
 * `requiredChecksPass` answered `{known: true, passed: true}` whenever no check
 * carried `required: true` -- and the only real client hardcoded
 * `required: false` on every check-run, because GitHub's check-runs API does
 * not carry requiredness at all (that is branch protection state). So
 * `checks.passed` was always true on the real path and the
 * `required_checks_not_passed` escalation was dead code: an advertised
 * protection that never ran.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluatePullRequest } = require('../lib/pr-guardian/policy');

function snapshot(checks) {
  return {
    repo: 'acme/app',
    number: 1,
    headSha: 'a'.repeat(40),
    workspaceId: 'github:acme/app',
    baseRef: 'main',
    headRef: 'feature',
    title: 'a change',
    body: '',
    files: [],
    checks,
  };
}

function check(name, conclusion, required) {
  return required === undefined
    ? { name, status: 'completed', conclusion }
    : { name, status: 'completed', conclusion, required };
}

test('a snapshot that cannot say what is required reports that, rather than "passed"', () => {
  const result = evaluatePullRequest(snapshot([check('CI', 'failure'), check('Lint', 'success')]));

  assert.ok(result.reasons.includes('required_checks_unknown'), JSON.stringify(result.reasons));
  assert.ok(!result.reasons.includes('required_checks_not_passed'), 'no verdict may be claimed from unknown state');
});

test('a failing required check still escalates to review', () => {
  const result = evaluatePullRequest(snapshot([check('CI', 'failure', true), check('Lint', 'success', true)]));

  assert.equal(result.decision, 'review');
  assert.ok(result.reasons.includes('required_checks_not_passed'), JSON.stringify(result.reasons));
  assert.ok(!result.reasons.includes('required_checks_unknown'));
});

test('passing required checks raise nothing', () => {
  const result = evaluatePullRequest(snapshot([check('CI', 'success', true), check('Lint', 'skipped', true)]));

  assert.equal(result.decision, 'allow');
  assert.ok(!result.reasons.includes('required_checks_not_passed'), JSON.stringify(result.reasons));
  assert.ok(!result.reasons.includes('required_checks_unknown'));
});

test('an empty check list is unknown, not "everything passed"', () => {
  const result = evaluatePullRequest(snapshot([]));

  assert.ok(result.reasons.includes('required_checks_unknown'));
});

test('unknown requiredness does not by itself change the decision', () => {
  const result = evaluatePullRequest(snapshot([check('CI', 'failure')]));

  assert.equal(result.decision, 'allow', 'surfacing the gap must not silently become a new blocking policy');
});
