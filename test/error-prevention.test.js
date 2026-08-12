'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  activateRule,
  preflight,
  proposeRule,
  recordFailure,
  supersedeRule,
} = require('../lib/error-prevention');

const action = {
  tool: 'http-server',
  operation: 'enforce-request-body-limit',
  scope: { workspace: 'huqan', repo: 'ali-ulu/huqan', path: 'server.js' },
};

function approvedRule(source = 'test_failure') {
  const failure = recordFailure({
    source,
    ...action,
    expected: 'HTTP 413',
    observed: 'ECONNRESET',
    evidence: { test: 'external-client-route-adversarial', verified: true },
  });
  const proposed = proposeRule(failure, {
    decision: 'block',
    provenance: { kind: 'test', ref: 'external-client-route-adversarial' },
  });
  return { failure, rule: activateRule(proposed, failure, { approved: true, approver: 'test-fixture' }) };
}

test('verified request-body-limit failure blocks an equivalent scoped action', () => {
  const { failure, rule } = approvedRule();
  assert.equal(failure.verification, 'verified');
  const result = preflight(action, [rule]);
  assert.equal(result.decision, 'block');
  assert.equal(result.reasonCode, 'ERROR_PREVENTION_RULE_MATCH');
  assert.deepEqual(result.matchedFailureIds, [failure.id]);
});

test('non-equivalent action is allowed and scope mismatch does not false-block', () => {
  const { rule } = approvedRule();
  assert.equal(preflight({ ...action, operation: 'read-request-body' }, [rule]).decision, 'allow');
  assert.equal(preflight({ ...action, scope: { ...action.scope, repo: 'other/repo' } }, [rule]).decision, 'allow');
});

test('model self-report cannot activate a hard-block rule', () => {
  const { failure, rule } = approvedRule('model_self_report');
  assert.equal(failure.verification, 'review');
  assert.equal(rule.state, 'quarantined');
  assert.equal(preflight(action, [rule]).decision, 'allow');
});

test('missing provenance fails closed to quarantine', () => {
  const failure = recordFailure({ source: 'ci_failure', ...action, expected: '413', observed: 'reset', evidence: { run: 1 } });
  const proposed = proposeRule(failure, { decision: 'block' });
  const rule = activateRule(proposed, failure, { approved: true, approver: 'ci' });
  assert.equal(rule.state, 'quarantined');
});

test('superseded rule no longer blocks', () => {
  const { rule } = approvedRule();
  const superseded = supersedeRule(rule, 'rule_replacement');
  assert.equal(preflight(action, [superseded]).decision, 'allow');
});

test('prevention never downgrades an existing stricter gate result', () => {
  const result = preflight({ tool: 'git', operation: 'status', scope: {} }, [], { existingDecision: 'block' });
  assert.equal(result.decision, 'block');
  assert.equal(result.preventionDecision, 'allow');
});
