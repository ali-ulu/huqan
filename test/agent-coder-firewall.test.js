'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateAgentActionFirewall } = require('../lib/agent-action-firewall');
const request = () => ({ tool: 'coder', action: 'code_change',
  input: { action: 'code_change', target: 'feature/value.js' },
  context: { branch: 'feat/coder', repoState: { known: true, dirty: false, hasUntracked: false } },
  approval: { explicit: true, approved: true, reviewed: true, reviewedBy: 'decision:operator' } });

test('exact approved Coder classification delegates to its code-change gate', () => {
  const result = evaluateAgentActionFirewall(request());
  assert.equal(result.decision, 'allow');
  assert.equal(result.reason, 'APPROVED_CODE_CHANGE_DELEGATED_TO_CODE_GATE');
  for (const field of ['explicit', 'approved', 'reviewed', 'reviewedBy']) {
    const input = request(); delete input.approval[field];
    assert.equal(evaluateAgentActionFirewall(input).decision, 'review', field);
  }
});
test('Coder classification does not admit another tool, action or task-supplied authority', () => {
  for (const change of [{ tool: 'evil.coder' }, { tool: 'external' }, { action: 'other' }]) {
    const input = { ...request(), ...change };
    if (change.action) input.input.action = change.action;
    assert.equal(evaluateAgentActionFirewall(input).decision, 'review');
  }
  const input = request(); delete input.approval; input.input.authorized = true;
  input.input.approval = request().approval;
  assert.equal(evaluateAgentActionFirewall(input).decision, 'review');
  for (const change of [
    { action: 'push_to_main', operationType: 'code_change' },
    { action: 'code_change', operationType: 'push_to_main' },
  ]) {
    const mixed = request(); Object.assign(mixed.input, change);
    assert.notEqual(evaluateAgentActionFirewall(mixed).decision, 'allow');
  }
  const mixed = request(); mixed.action = 'push_to_main';
  assert.notEqual(evaluateAgentActionFirewall(mixed).decision, 'allow');
});
test('Coder classification preserves dry-run, preview, policy and dirty-repository floors', () => {
  for (const field of ['preview', 'dryRun'])
    assert.equal(evaluateAgentActionFirewall({ ...request(), [field]: true }).decision, 'dry_run_only');
  for (const decision of ['review', 'block'])
    assert.equal(evaluateAgentActionFirewall({ ...request(), policyOverride: { minimumDecision: decision } }).decision, decision);
  for (const field of ['dirty', 'hasUntracked']) {
    const input = request(); input.context.repoState[field] = true;
    assert.equal(evaluateAgentActionFirewall(input).decision, 'review');
  }
});
test('Coder classification never lowers a secret or automation hazard', () => {
  const secret = request(); secret.input.credentials = { apiKey: 'super-secret-api-key' };
  assert.equal(evaluateAgentActionFirewall(secret).decision, 'block');
  const hazard = request(); hazard.input.command = 'git push --force origin main';
  assert.equal(evaluateAgentActionFirewall(hazard).decision, 'review');
});
