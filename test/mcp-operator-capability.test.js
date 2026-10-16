'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  capabilityBinding,
  createMcpOperatorCapability,
  verifyMcpOperatorCapability,
} = require('../lib/mcp-operator-capability');

const SECRET = 'operator-test-secret';
const NOW = Date.parse('2026-08-27T00:00:00.000Z');

function makeCapability(overrides = {}) {
  const binding = capabilityBinding({
    tool: 'huqan.approve',
    workspaceId: 'workspace-a',
    approvalId: 'approval-1',
    runId: null,
    arguments: { approvalId: 'approval-1', workspaceId: 'workspace-a', decision: 'approved' },
  });
  return {
    binding,
    capability: createMcpOperatorCapability({ secret: SECRET, ...binding, now: NOW, nonce: 'nonce-1', ...overrides }),
  };
}

test('MCP operator capability is bound to tool, workspace and action hash', () => {
  const { binding, capability } = makeCapability();
  const nonceStore = new Map();
  const verified = verifyMcpOperatorCapability({
    secret: SECRET,
    capability,
    expected: binding,
    now: NOW,
    nonceStore,
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.payload.tool, 'huqan.approve');
  assert.equal(verified.payload.workspaceId, 'workspace-a');
  assert.equal(verified.payload.approvalId, 'approval-1');
  assert.equal(nonceStore.has('nonce-1'), true);

  const replay = verifyMcpOperatorCapability({
    secret: SECRET,
    capability,
    expected: binding,
    now: NOW,
    nonceStore,
  });
  assert.deepEqual(replay, { ok: false, reason: 'capability.replayed' });
});

test('MCP operator capability refuses scope substitution', () => {
  const { capability, binding } = makeCapability();
  const result = verifyMcpOperatorCapability({
    secret: SECRET,
    capability,
    expected: { ...binding, workspaceId: 'workspace-b' },
    now: NOW,
  });
  assert.deepEqual(result, { ok: false, reason: 'capability.scope_mismatch' });
});

test('MCP operator capability refuses expiry and signature tampering', () => {
  const { binding, capability } = makeCapability({ ttlMs: 1000 });
  const expired = verifyMcpOperatorCapability({
    secret: SECRET,
    capability,
    expected: binding,
    now: NOW + 2000,
  });
  assert.deepEqual(expired, { ok: false, reason: 'capability.expired' });

  const tampered = verifyMcpOperatorCapability({
    secret: SECRET,
    capability: `${capability.slice(0, -1)}x`,
    expected: binding,
    now: NOW,
  });
  assert.deepEqual(tampered, { ok: false, reason: 'capability.invalid' });
});
