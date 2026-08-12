'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const MemoryStore = require('../lib/memory-store');
const { createErrorPrevention } = require('../lib/error-prevention');

function makeEngine({ authorities = true } = {}) {
  const memory = new MemoryStore({ useSQLite: false });
  const options = authorities ? {
    verifyEvidence({ source, evidence }) {
      return source === 'test_failure'
        && evidence.some((item) => item?.type === 'test' && item?.verifiedBy === 'ci');
    },
    resolveApproval({ approvalIdHint }) {
      if (approvalIdHint === 'approval-authoritative') {
        return { approvalId: approvalIdHint, status: 'approved' };
      }
      if (approvalIdHint === 'approval-rejected') {
        return { approvalId: approvalIdHint, status: 'rejected' };
      }
      return { approvalId: approvalIdHint || '', status: 'pending' };
    },
  } : {};
  return { memory, prevention: createErrorPrevention(memory, options) };
}

function recordHttpFailure(prevention, overrides = {}) {
  return prevention.recordFailure({
    source: 'test_failure',
    tool: 'edit',
    operation: 'modify_http_body_limit',
    workspaceId: 'huqan',
    repo: 'ali-ulu/huqan',
    path: 'server.js',
    expected: 'HTTP 413',
    observed: 'ECONNRESET',
    evidence: [{ type: 'test', ref: 'external-client-route-adversarial.test.js', verifiedBy: 'ci' }],
    ...overrides,
  });
}

test('objective source labels are candidates until a trusted evidence verifier approves them', () => {
  const { prevention } = makeEngine({ authorities: false });
  const objective = recordHttpFailure(prevention);
  assert.equal(objective.ok, true);
  assert.equal(objective.failure.verificationStatus, 'candidate');
  assert.equal(objective.failure.verificationReason, 'verifier_unavailable');

  const selfReport = prevention.recordFailure({
    source: 'model_self_report', operation: 'edit_config', observed: 'maybe wrong',
    evidence: [{ type: 'model' }],
  });
  assert.equal(selfReport.ok, true);
  assert.equal(selfReport.failure.verificationStatus, 'unverified');
});

test('trusted evidence authority can verify an objective failure', () => {
  const { prevention } = makeEngine();
  const verified = recordHttpFailure(prevention);
  assert.equal(verified.ok, true);
  assert.equal(verified.failure.verificationStatus, 'verified');
  assert.equal(verified.failure.verificationReason, 'verified_by_authority');
});

test('unverified failure cannot activate a hard prevention rule', () => {
  const { prevention } = makeEngine();
  const failure = prevention.recordFailure({
    source: 'model_self_report', operation: 'edit_config', observed: 'maybe wrong',
  });
  const proposed = prevention.proposeRule(failure.memory.memoryId, { enforcement: 'block' });
  const activation = prevention.activateRule(proposed.memory.memoryId, { approvalId: 'approval-authoritative' });
  assert.equal(activation.ok, false);
  assert.equal(activation.error.code, 'UNVERIFIED_FAILURE_CANNOT_ACTIVATE');
});

test('caller-supplied approvalStatus cannot forge rule activation', () => {
  const { prevention } = makeEngine();
  const failure = recordHttpFailure(prevention);
  const proposed = prevention.proposeRule(failure.memory.memoryId, {
    workspaceId: 'huqan', enforcement: 'block',
  });
  const forged = prevention.activateRule(proposed.memory.memoryId, {
    workspaceId: 'huqan', approvalStatus: 'approved', approvalId: 'not-authoritative',
  });
  assert.equal(forged.ok, false);
  assert.equal(forged.decision.decision, 'review');
  assert.equal(forged.decision.approvalStatus, 'pending');
});

test('approved verified rule blocks exact scoped 413 to ECONNRESET repeat without false blocking', () => {
  const { prevention } = makeEngine();
  const failure = recordHttpFailure(prevention);
  const proposed = prevention.proposeRule(failure.memory.memoryId, {
    workspaceId: 'huqan', enforcement: 'block',
    constraint: 'Do not destroy the request before sending the HTTP error response.',
    remediation: 'Write the 413 response before closing the request.',
  });

  const pending = prevention.activateRule(proposed.memory.memoryId, { workspaceId: 'huqan' });
  assert.equal(pending.ok, false);
  assert.equal(pending.decision.decision, 'review');

  const active = prevention.activateRule(proposed.memory.memoryId, {
    workspaceId: 'huqan', approvalId: 'approval-authoritative', approvalStatus: 'rejected',
  });
  assert.equal(active.ok, true, 'trusted resolver, not caller approvalStatus, controls activation');
  assert.equal(active.rule.status, 'active');

  const blocked = prevention.preflight({
    tool: 'edit', operation: 'modify_http_body_limit', workspaceId: 'huqan',
    repo: 'ali-ulu/huqan', path: 'server.js',
  });
  assert.equal(blocked.decision, 'block');
  assert.equal(blocked.blocked, true);
  assert.deepEqual(blocked.reasonCodes, ['PREVIOUS_VERIFIED_FAILURE', 'PREVENTION_BLOCK']);
  assert.equal(blocked.matchedRules[0].sourceFailureId, failure.failure.failureId);
  assert.match(blocked.receipt.receiptId, /^ep_receipt_/);

  const otherPath = prevention.preflight({
    tool: 'edit', operation: 'modify_http_body_limit', workspaceId: 'huqan',
    repo: 'ali-ulu/huqan', path: 'README.md',
  });
  assert.equal(otherPath.decision, 'allow');

  const otherWorkspace = prevention.preflight({
    tool: 'edit', operation: 'modify_http_body_limit', workspaceId: 'other',
    repo: 'ali-ulu/huqan', path: 'server.js',
  });
  assert.equal(otherWorkspace.decision, 'allow');
});

test('superseded prevention rule no longer blocks', () => {
  const { prevention } = makeEngine();
  const failure = recordHttpFailure(prevention);
  const proposed = prevention.proposeRule(failure.memory.memoryId, {
    workspaceId: 'huqan', enforcement: 'block',
  });
  const active = prevention.activateRule(proposed.memory.memoryId, {
    workspaceId: 'huqan', approvalId: 'approval-authoritative',
  });
  const replacement = prevention.supersedeRule(active.memory.memoryId, {
    enforcement: 'require_verify',
  }, {
    workspaceId: 'huqan', approvalId: 'approval-authoritative',
  });
  assert.equal(replacement.ok, true);

  const result = prevention.preflight({
    tool: 'edit', operation: 'modify_http_body_limit', workspaceId: 'huqan',
    repo: 'ali-ulu/huqan', path: 'server.js',
  });
  assert.equal(result.decision, 'review');
  assert.equal(result.matchedRules.length, 1);
  assert.equal(result.matchedRules[0].ruleId, replacement.rule.ruleId);
});
