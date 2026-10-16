'use strict';

// #3926: a workflow learn decision executes a canonical write, so the
// transport API key alone must not authorize it. These tests pin the gate the
// decision route consults: same `huqan.approve` binding the memory-approval
// surface verifies, same header, and a spent capability never verifies twice.

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { createMcpOperatorCapability, operatorCapabilityBinding } = require('../mcpServer');
const {
  OPERATOR_DECISION_HEADER,
  workflowDecisionNonceDirectory,
  readWorkflowDecisionCapability,
  verifyWorkflowDecisionCapability,
} = require('../lib/http/workflow-decision-gate');

const SECRET = 'test-operator-secret-just-for-this-file';
const ARGS = { approvalId: 'learn-1', workspaceId: 'alpha', decision: 'approved', reason: '' };

function mint(secret, args) {
  return createMcpOperatorCapability({ secret, ...operatorCapabilityBinding('huqan.approve', args) });
}

describe('workflow decision gate (#3926)', () => {
  it('shares the operator capability header with the memory-approval surface', () => {
    assert.equal(OPERATOR_DECISION_HEADER, 'x-huqan-operator-capability');
  });

  it('verifies a capability minted for the exact decision', () => {
    assert.equal(verifyWorkflowDecisionCapability({
      operatorToken: SECRET, capability: mint(SECRET, ARGS), ...ARGS, nonceStore: new Map(),
    }), true);
  });

  it('refuses without a token, without a capability, or without a decision', () => {
    const capability = mint(SECRET, ARGS);
    assert.equal(verifyWorkflowDecisionCapability({ capability, ...ARGS }), false);
    assert.equal(verifyWorkflowDecisionCapability({ operatorToken: SECRET, ...ARGS }), false);
    assert.equal(verifyWorkflowDecisionCapability({ operatorToken: SECRET, capability, workspaceId: 'alpha' }), false);
    assert.equal(verifyWorkflowDecisionCapability(), false);
  });

  it('refuses a capability minted under another secret', () => {
    const capability = mint('another-secret', ARGS);
    assert.equal(verifyWorkflowDecisionCapability({ operatorToken: SECRET, capability, ...ARGS, nonceStore: new Map() }), false);
  });

  it('refuses a capability bound to another approval or decision', () => {
    const otherApproval = mint(SECRET, { ...ARGS, approvalId: 'learn-2' });
    assert.equal(verifyWorkflowDecisionCapability({ operatorToken: SECRET, capability: otherApproval, ...ARGS, nonceStore: new Map() }), false);
    const otherDecision = mint(SECRET, { ...ARGS, decision: 'rejected' });
    assert.equal(verifyWorkflowDecisionCapability({ operatorToken: SECRET, capability: otherDecision, ...ARGS, nonceStore: new Map() }), false);
  });

  it('spends a capability on first use', () => {
    const nonces = new Map();
    const capability = mint(SECRET, ARGS);
    const input = { operatorToken: SECRET, capability, ...ARGS, nonceStore: nonces };
    assert.equal(verifyWorkflowDecisionCapability(input), true);
    assert.equal(verifyWorkflowDecisionCapability(input), false);
  });

  it('reads the capability from the request headers', () => {
    assert.equal(readWorkflowDecisionCapability({ headers: { 'x-huqan-operator-capability': 'cap' } }), 'cap');
    assert.equal(readWorkflowDecisionCapability({ headers: {} }), '');
    assert.equal(readWorkflowDecisionCapability({}), '');
    assert.equal(readWorkflowDecisionCapability(), '');
  });

  it('defaults the nonce directory beside the memory store, or the state root', () => {
    const path = require('node:path');
    const os = require('node:os');
    const beside = workflowDecisionNonceDirectory({ graph: { memoryPath: '/var/lib/huqan/memory.db' } });
    assert.equal(beside, path.join(path.dirname(path.resolve('/var/lib/huqan/memory.db')), '.huqan-capability-nonces'));
    const fallback = workflowDecisionNonceDirectory(null);
    assert.equal(fallback, path.join(os.homedir(), '.local', 'state', 'huqan', '.huqan-capability-nonces'));
    assert.equal(workflowDecisionNonceDirectory({}), fallback);
  });
});
