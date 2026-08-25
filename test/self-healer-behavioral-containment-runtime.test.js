'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  BEHAVIORAL_RUNTIME_VERSION,
  createBehavioralContainmentRuntime,
} = require('../lib/self-healer/behavioral-containment-runtime');

test('scoped quarantine suppresses only the matching workspace and agent', () => {
  const runtime = createBehavioralContainmentRuntime({ clock: () => Date.parse('2026-08-25T10:00:00.000Z') });
  const contained = runtime.record({
    workspaceId: 'workspace-a',
    agentId: 'agent-a',
    action: 'quarantine',
    reason: 'unexpected_tool',
    baselineHash: 'baseline-a',
    deviationCode: 'unexpected_tool',
  });

  assert.equal(contained.ok, true);
  assert.equal(contained.version, BEHAVIORAL_RUNTIME_VERSION);
  assert.equal(contained.executorSuppressed, true);
  assert.deepEqual(contained.scope, { workspaceId: 'workspace-a', agentId: 'agent-a' });
  assert.equal(contained.revocation, null);
  assert.equal(runtime.guardExecution({ workspaceId: 'workspace-a', agentId: 'agent-a' }).allowed, false);
  assert.equal(runtime.guardExecution({ workspaceId: 'workspace-b', agentId: 'agent-a' }).allowed, true);
  assert.equal(runtime.guardExecution({ workspaceId: 'workspace-a', agentId: 'agent-b' }).allowed, true);
});

test('logical revoke is fail-closed and explicitly does not claim credential revocation', () => {
  const runtime = createBehavioralContainmentRuntime();
  const revoked = runtime.revoke({ workspaceId: 'workspace-a', agentId: 'agent-a', reason: 'operator containment' });
  assert.equal(revoked.ok, true);
  assert.equal(revoked.action, 'revoke');
  assert.equal(revoked.executorSuppressed, true);
  assert.deepEqual(revoked.revocation, { kind: 'logical_executor_capability', credentialsUntouched: true });
  assert.equal(runtime.guardExecution({ workspaceId: 'workspace-a', agentId: 'agent-a' }).code, 'BEHAVIORAL_REVOKE_ACTIVE');
});

test('reintegration requires all fresh checks and operator approval, then releases the exact scope', () => {
  const runtime = createBehavioralContainmentRuntime();
  runtime.record({ workspaceId: 'workspace-a', agentId: 'agent-a', action: 'quarantine', reason: 'drift' });

  const incomplete = runtime.reintegrate({
    workspaceId: 'workspace-a',
    agentId: 'agent-a',
    verification: { fresh_identity_verification: true, fresh_dependency_verification: true },
    operatorApproval: true,
  });
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.reason, 'behavioral_reintegration_verification_required');
  assert.equal(runtime.guardExecution({ workspaceId: 'workspace-a', agentId: 'agent-a' }).allowed, false);

  const restored = runtime.reintegrate({
    workspaceId: 'workspace-a',
    agentId: 'agent-a',
    verification: {
      fresh_identity_verification: true,
      fresh_dependency_verification: true,
      fresh_policy_verification: true,
    },
    operatorApproval: true,
  });
  assert.equal(restored.ok, true);
  assert.equal(restored.status, 'reintegrated');
  assert.deepEqual(restored.scope, { workspaceId: 'workspace-a', agentId: 'agent-a' });
  assert.equal(runtime.guardExecution({ workspaceId: 'workspace-a', agentId: 'agent-a' }).allowed, true);
});
