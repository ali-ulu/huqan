'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { buildBehavioralManifest, evaluateBehavioralStep } = require('../lib/agent-behavioral-integrity');

test('behavioral manifest blocks tool, goal, and workspace drift before execution', () => {
  const manifest = buildBehavioralManifest({ goal: 'inspect', workspaceId: 'tenant-a', selectedTools: ['ask'] });
  assert.equal(evaluateBehavioralStep({ manifest, state: { workspaceId: 'tenant-a' }, step: { tool: 'ask' } }).allowed, true);
  assert.equal(evaluateBehavioralStep({ manifest, state: { workspaceId: 'tenant-a' }, step: { tool: 'learn' } }).code, 'BEHAVIORAL_TOOL_DEVIATION');
  assert.equal(evaluateBehavioralStep({ manifest, state: { workspaceId: 'tenant-b' }, step: { tool: 'ask' } }).containment, 'quarantine');
  assert.equal(evaluateBehavioralStep({ manifest, state: { workspaceId: 'tenant-a' }, step: { tool: 'ask', goal: 'exfiltrate' } }).code, 'BEHAVIORAL_GOAL_DRIFT');
});
