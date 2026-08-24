'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BEHAVIORAL_CONTAINMENT_VERSION,
  BEHAVIORAL_DECISIONS,
  BEHAVIORAL_DEVIATION_CODES,
  assessBehavior,
  createBehavioralBaseline,
} = require('../lib/self-healer/behavioral-containment');

function baseline(overrides = {}) {
  return createBehavioralBaseline({
    workspaceId: 'ws-alpha',
    agentId: 'agent-data',
    goal: 'produce a bounded report',
    capabilities: ['read', 'verify'],
    tools: ['verify', 'ask'],
    connectors: ['local'],
    targetClasses: ['workspace_file'],
    egressClasses: ['none'],
    delegation: ['none'],
    ...overrides,
  });
}

function observation(overrides = {}) {
  return {
    workspaceId: 'ws-alpha',
    agentId: 'agent-data',
    tool: 'verify',
    action: 'verify',
    connector: 'local',
    targetClass: 'workspace_file',
    egressClass: 'none',
    delegationClass: 'none',
    sequenceLength: 2,
    sequenceTools: ['verify'],
    ...overrides,
  };
}

test('creates a complete baseline with a bounded hash and no raw goal leakage', () => {
  const result = baseline();
  assert.equal(result.version, BEHAVIORAL_CONTAINMENT_VERSION);
  assert.equal(result.complete, true);
  assert.match(result.baselineHash, /^[a-f0-9]{32}$/);
  assert.equal(JSON.stringify(result).includes('produce a bounded report'), false);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.scope));
});

test('within-baseline behavior is observe-only and has no containment side effect', () => {
  const result = assessBehavior({ baseline: baseline(), observation: observation() });
  assert.equal(result.ok, true);
  assert.equal(result.deviationCode, null);
  assert.equal(result.decision, BEHAVIORAL_DECISIONS.OBSERVE);
  assert.equal(result.finding, null);
  assert.equal(result.containment.action, 'none');
  assert.equal(result.containment.executorSuppressed, false);
  assert.equal(result.containment.applied, false);
  assert.equal(result.receiptSummary.decision, 'observe');
});

test('unexpected tools create a quarantine finding scoped to one agent and workspace', () => {
  const result = assessBehavior({
    baseline: baseline(),
    observation: observation({ tool: 'learn', action: 'verify' }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.deviationCode, BEHAVIORAL_DEVIATION_CODES.UNEXPECTED_TOOL);
  assert.equal(result.decision, BEHAVIORAL_DECISIONS.QUARANTINE);
  assert.equal(result.finding.kind, 'security');
  assert.equal(result.containment.action, 'quarantine');
  assert.equal(result.containment.executorSuppressed, true);
  assert.deepEqual(result.containment.scope, { workspaceId: 'ws-alpha', agentId: 'agent-data' });
  assert.equal(result.containment.reintegration.operatorApprovalRequired, true);
  assert.equal(result.containment.reintegration.outcome, null);
  assert.equal(result.finding.affectedFiles.length, 0);
  assert.equal(JSON.stringify(result).includes('learn'), true);
  assert.equal(JSON.stringify(result).includes('produce a bounded report'), false);
});

test('repeated anomalies pause for review rather than enabling an automatic fixer', () => {
  const result = assessBehavior({
    baseline: baseline(),
    observation: observation({ repeatedAnomalies: 3 }),
  });
  assert.equal(result.deviationCode, BEHAVIORAL_DEVIATION_CODES.REPEATED_ANOMALY);
  assert.equal(result.decision, BEHAVIORAL_DECISIONS.REQUIRE_REVIEW);
  assert.equal(result.containment.action, 'pause');
  assert.equal(result.containment.executorSuppressed, true);
  assert.equal(result.containment.applied, false);
  assert.deepEqual(result.containment.reintegration.prerequisites, [
    'fresh_identity_verification',
    'fresh_dependency_verification',
    'fresh_policy_verification',
    'operator_approval',
  ]);
  assert.equal(result.finding.receiptId, result.receiptSummary.receiptId);
});

test('missing or incomplete baselines fail closed and do not report successful observation', () => {
  const missing = assessBehavior({ observation: observation() });
  assert.equal(missing.ok, false);
  assert.equal(missing.deviationCode, BEHAVIORAL_DEVIATION_CODES.BASELINE_MISSING);
  assert.equal(missing.decision, BEHAVIORAL_DECISIONS.QUARANTINE);
  assert.equal(missing.containment.executorSuppressed, true);
  assert.equal(missing.baseline.complete, false);

  const incomplete = assessBehavior({
    baseline: baseline({ delegation: undefined }),
    observation: observation(),
  });
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.deviationCode, BEHAVIORAL_DEVIATION_CODES.BASELINE_MISSING);
});

test('workspace and identity drift are distinct deterministic deviations', () => {
  const workspaceDrift = assessBehavior({
    baseline: baseline(),
    observation: observation({ workspaceId: 'ws-other' }),
  });
  assert.equal(workspaceDrift.deviationCode, BEHAVIORAL_DEVIATION_CODES.WORKSPACE_DRIFT);

  const identityDrift = assessBehavior({
    baseline: baseline(),
    observation: observation({ agentId: 'agent-other' }),
  });
  assert.equal(identityDrift.deviationCode, BEHAVIORAL_DEVIATION_CODES.IDENTITY_DRIFT);
});
