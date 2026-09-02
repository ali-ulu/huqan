'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { evaluateExternalAction, recordExternalActionOutcome } = require('../lib/external-action-guard');
const { computeTrustScore, evaluateGraduatedAutonomy, GRADUATED_AUTONOMY_VERSION } = require('../lib/graduated-autonomy');
const { POST_ACTION_MONITOR_VERSION } = require('../lib/post-action-monitor');
const { buildCanonicalReceiptPayload, hashCanonicalReceiptPayload } = require('../lib/receipt/canonical-receipt');
const { fromMcpDecision } = require('../lib/verdict/action-verdict');

const ROOT = process.cwd();
const IDENTITY_REF = 'agent:default:monitor-agent';

function activation() {
  return {
    status: 'approved',
    approvalId: 'monitor-activation-1',
    actor: 'actor:operator',
    actorType: 'human',
    approvedAt: '2026-01-01T00:00:00.000Z',
  };
}

function invocation(overrides = {}) {
  return {
    invocationId: 'post-action-1',
    agentName: 'monitor-agent',
    sessionId: 'monitor-session',
    toolName: 'Read',
    args: { file_path: path.join(ROOT, 'README.md') },
    cwd: ROOT,
    workspaceRoot: ROOT,
    workspaceId: 'default',
    identity: {
      schemaVersion: 'huqan.agent-identity-card.v1',
      agentId: 'monitor-agent',
      agentName: 'monitor-agent',
      ownerActorId: 'actor:operator',
      workspaceId: 'default',
      capabilities: ['file_read'],
      issuedAt: '2026-01-01T00:00:00.000Z',
    },
    ...overrides,
  };
}

function baseline(overrides = {}) {
  return {
    goal: 'bounded external action monitoring',
    capabilities: ['read'],
    tools: ['read'],
    connectors: ['local'],
    targetClasses: ['workspace_path'],
    egressClasses: ['none'],
    delegation: ['none'],
    ...overrides,
  };
}

function admit(input = invocation()) {
  const persisted = [];
  const result = evaluateExternalAction(input, {
    receiptWriter: { append: receipt => persisted.push(receipt) },
    now: () => '2026-01-01T00:10:00.000Z',
  });
  assert.equal(result.decision, 'allow');
  return { result, persisted };
}

function sealReceipt(receipt) {
  const materialized = {
    workspaceId: 'default',
    actor: 'monitor-agent',
    agentId: 'monitor-agent',
    memoryDraftId: 'not_applicable',
    provenanceId: 'external:monitor-agent:history',
    trustPolicyVersion: 'huqan-external-action-guard-v1',
    approvalId: 'not_applicable',
    approvalStatus: 'not_required',
    reason: 'state',
    riskScore: 0,
    ...receipt,
  };
  const canonical = buildCanonicalReceiptPayload(materialized, {
    verdict: fromMcpDecision({ decision: materialized.decision, reason: materialized.reason }).verdict,
  });
  return { ...canonical, receiptHash: hashCanonicalReceiptPayload(canonical) };
}

test('post-action monitoring requires human activation before automatic containment', () => {
  const input = invocation();
  const { result: admission, persisted } = admit(input);
  const outcome = recordExternalActionOutcome(input, admission.receipt, { status: 'success' }, {
    continuousMonitoring: { enabled: true, baseline: baseline() },
    receiptWriter: { append: receipt => persisted.push(receipt) },
    now: () => '2026-01-01T00:11:00.000Z',
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.monitoring.active, false);
  assert.equal(outcome.monitoring.receiptSummary.activationRequired, true);
  assert.equal(outcome.quarantined, false);
  assert.equal(outcome.receipt.metadata.monitoring.decision, 'activation_required');
  assert.equal(outcome.monitoringError, 'post_action_monitoring_requires_human_activation');
  assert.equal(persisted.length, 2);
});

test('future-dated or non-human activation cannot arm automatic containment', () => {
  const input = invocation({ invocationId: 'post-action-invalid-activation' });
  const { result: admission, persisted } = admit(input);
  const outcome = recordExternalActionOutcome(input, admission.receipt, {
    status: 'success',
    anomaly: true,
  }, {
    continuousMonitoring: {
      enabled: true,
      baseline: baseline(),
      activation: { ...activation(), approvedAt: '2027-01-01T00:00:00.000Z' },
    },
    receiptWriter: { append: receipt => persisted.push(receipt) },
    now: () => '2026-01-01T00:11:00.000Z',
  });

  assert.equal(outcome.monitoring.active, false);
  assert.equal(outcome.monitoring.anomaly, false);
  assert.equal(outcome.quarantined, false);
  assert.equal(outcome.receipt.metadata.monitoring.activationRequired, true);
  assert.equal(outcome.ok, false);
});

test('healthy post-action behavior is collected without containment', () => {
  const input = invocation({ invocationId: 'post-action-healthy' });
  const { result: admission, persisted } = admit(input);
  const outcome = recordExternalActionOutcome(input, admission.receipt, {
    status: 'success',
    durationMs: 37,
    sideEffectCount: 0,
  }, {
    continuousMonitoring: { enabled: true, baseline: baseline(), activation: activation() },
    receiptWriter: { append: receipt => persisted.push(receipt) },
    now: () => '2026-01-01T00:11:00.000Z',
  });

  assert.equal(outcome.monitoring.receiptSummary.schemaVersion, POST_ACTION_MONITOR_VERSION);
  assert.equal(outcome.monitoring.receiptSummary.signal.durationMs, 37);
  assert.equal(outcome.monitoring.anomaly, false);
  assert.equal(outcome.quarantined, false);
  assert.equal(outcome.receipt.metadata.monitoring.decision, 'observe');
  assert.match(outcome.receipt.receiptHash, /^[a-f0-9]{64}$/);
});

test('anomaly is classified through the self-healer seam and durably quarantined', () => {
  const input = invocation({ invocationId: 'post-action-anomaly' });
  const { result: admission, persisted } = admit(input);
  const findings = [];
  const outcome = recordExternalActionOutcome(input, admission.receipt, {
    status: 'success',
    behavioralObservation: { tool: 'Bash', action: 'read' },
  }, {
    continuousMonitoring: {
      enabled: true,
      baseline: baseline(),
      activation: activation(),
      findingSink: finding => findings.push(finding),
    },
    receiptWriter: { append: receipt => persisted.push(receipt) },
    now: () => '2026-01-01T00:11:00.000Z',
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.quarantined, true);
  assert.equal(outcome.demotedTo, 'T1');
  assert.equal(outcome.finding.kind, 'security');
  assert.equal(outcome.finding.severity, 'high');
  assert.equal(findings.length, 1, 'the existing finding pipeline receives the classified finding after persistence');
  assert.equal(outcome.receipt.metadata.monitoring.anomaly, true);
  assert.equal(outcome.receipt.metadata.monitoring.quarantine.applied, true);
  assert.equal(outcome.receipt.metadata.monitoring.activation.actorType, 'human');
  assert.equal(persisted.at(-1).receiptId, outcome.receipt.receiptId);
});

test('anomaly quarantine fails closed when its receipt is not durable', () => {
  const input = invocation({ invocationId: 'post-action-no-writer' });
  const { result: admission } = admit(input);
  const outcome = recordExternalActionOutcome(input, admission.receipt, {
    status: 'success',
    anomaly: true,
    anomalyCode: 'runtime_policy_drift',
  }, {
    continuousMonitoring: { enabled: true, baseline: baseline(), activation: activation() },
    now: () => '2026-01-01T00:11:00.000Z',
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.receiptPersisted, false);
  assert.equal(outcome.quarantined, false);
  assert.equal(outcome.demotedTo, null);
  assert.match(outcome.receiptError, /requires durable receipt persistence/);
});

test('finding-pipeline failure is reported after durable quarantine', () => {
  const input = invocation({ invocationId: 'post-action-finding-sink' });
  const { result: admission, persisted } = admit(input);
  const outcome = recordExternalActionOutcome(input, admission.receipt, {
    status: 'success',
    policyViolation: true,
  }, {
    continuousMonitoring: {
      enabled: true,
      baseline: baseline(),
      activation: activation(),
      findingSink() { throw new Error('finding pipeline unavailable'); },
    },
    receiptWriter: { append: receipt => persisted.push(receipt) },
    now: () => '2026-01-01T00:11:00.000Z',
  });

  assert.equal(outcome.receiptPersisted, true);
  assert.equal(outcome.quarantined, true);
  assert.equal(outcome.ok, false);
  assert.match(outcome.monitoringError, /finding pipeline unavailable/);
});

test('hash-valid quarantine evidence is a critical violation that demotes T3 to T1', () => {
  const input = invocation({ invocationId: 'post-action-demotion' });
  const { result: admission, persisted } = admit(input);
  const outcome = recordExternalActionOutcome(input, admission.receipt, {
    status: 'success',
    policyViolation: true,
  }, {
    continuousMonitoring: { enabled: true, baseline: baseline(), activation: activation() },
    receiptWriter: { append: receipt => persisted.push(receipt) },
    now: () => '2026-01-01T00:11:00.000Z',
  });
  const state = sealReceipt({
    receiptId: 'autonomy-t3-state',
    receiptKind: 'external_action_autonomy_state',
    admissionId: 'autonomy-t3-state',
    decision: 'allow',
    status: 'admitted',
    createdAt: '2026-01-01T00:10:30.000Z',
    metadata: {
      identity: admission.receipt.metadata.identity,
      autonomy: {
        schemaVersion: GRADUATED_AUTONOMY_VERSION,
        identityRef: IDENTITY_REF,
        tier: 'T3',
        evaluatedAt: '2026-01-01T00:10:30.000Z',
        firstActivation: activation(),
      },
    },
  });
  const history = [admission.receipt, state, outcome.receipt];
  const metrics = computeTrustScore(history, IDENTITY_REF);
  assert.equal(metrics.violations, 1);
  assert.equal(metrics.latestViolation.critical, true);
  assert.equal(metrics.latestViolation.source, 'post_action_anomaly');

  const next = evaluateGraduatedAutonomy({
    identity: admission.receipt.metadata.identity,
    action: { riskCategory: 'READ_ONLY' },
    receipts: history,
  }, { now: () => '2026-01-01T00:12:00.000Z' });
  assert.equal(next.autonomy.tier, 'T1');
  assert.equal(next.autonomy.transition.status, 'demoted');
  assert.equal(next.autonomy.transition.trigger, 'violation');

  const writeInput = invocation({
    invocationId: 'post-action-next-write',
    toolName: 'Write',
    args: { file_path: path.join(ROOT, 'quarantined.txt'), content: 'blocked by ceiling' },
    identity: { ...input.identity, capabilities: ['file_read', 'file_write'] },
  });
  const enforced = evaluateExternalAction(writeInput, {
    continuousMonitoring: { enabled: true, baseline: baseline(), activation: activation(), receipts: history },
    receiptWriter: { append() {} },
    now: () => '2026-01-01T00:12:00.000Z',
  });
  const autonomyFinding = enforced.findings.find(finding => finding.gate === 'graduated-autonomy');
  assert.equal(autonomyFinding.tier, 'T1');
  assert.equal(autonomyFinding.requiredTier, 'T2');
  assert.equal(autonomyFinding.decision, 'review');
  assert.equal(enforced.metadata.autonomy.transition.status, 'demoted');
});

test('tampered quarantine metadata cannot create a demotion signal', () => {
  const input = invocation({ invocationId: 'post-action-tamper' });
  const { result: admission, persisted } = admit(input);
  const outcome = recordExternalActionOutcome(input, admission.receipt, { status: 'success' }, {
    continuousMonitoring: { enabled: true, baseline: baseline(), activation: activation() },
    receiptWriter: { append: receipt => persisted.push(receipt) },
    now: () => '2026-01-01T00:11:00.000Z',
  });
  const tampered = {
    ...outcome.receipt,
    metadata: {
      ...outcome.receipt.metadata,
      monitoring: {
        ...outcome.receipt.metadata.monitoring,
        anomaly: true,
        quarantine: { applied: true, demotedTo: 'T1', humanReleaseRequired: true },
      },
    },
  };
  const metrics = computeTrustScore([admission.receipt, tampered], IDENTITY_REF);
  assert.equal(metrics.violations, 0);
  assert.equal(metrics.successes, 0, 'the invalid-hash outcome contributes neither success nor violation');
});
