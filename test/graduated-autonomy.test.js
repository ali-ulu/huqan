'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  AUTONOMY_REASONS,
  GRADUATED_AUTONOMY_VERSION,
  computeTrustScore,
  evaluateGraduatedAutonomy,
  requiredTierForAction,
} = require('../lib/graduated-autonomy');
const { evaluateExternalAction, recordExternalActionOutcome } = require('../lib/external-action-guard');
const { buildCanonicalReceiptPayload, hashCanonicalReceiptPayload } = require('../lib/receipt/canonical-receipt');
const { fromMcpDecision } = require('../lib/verdict/action-verdict');

const IDENTITY_REF = 'agent:default:future-agent-2035';
const START = Date.parse('2026-01-01T00:00:00.000Z');
const WORKSPACE_ROOT = process.cwd();

function identity() {
  return { identityRef: IDENTITY_REF, agentId: 'future-agent-2035', attested: true };
}

function receiptIdentity() {
  return { identityRef: IDENTITY_REF, agentId: 'future-agent-2035' };
}

function sealReceipt(receipt) {
  const materialized = {
    workspaceId: 'default',
    actor: 'future-agent-2035',
    agentId: 'future-agent-2035',
    memoryDraftId: 'not_applicable',
    provenanceId: 'external:future-agent-2035:history',
    trustPolicyVersion: 'huqan-external-action-guard-v1',
    approvalId: 'not_applicable',
    approvalStatus: 'not_required',
    reason: receipt.status,
    riskScore: 0,
    ...receipt,
  };
  const canonical = buildCanonicalReceiptPayload(materialized, {
    verdict: fromMcpDecision({ decision: materialized.decision, reason: materialized.reason }).verdict,
  });
  return { ...canonical, receiptHash: hashCanonicalReceiptPayload(canonical) };
}

function actionReceipts(count, options = {}) {
  const receipts = [];
  for (let index = 0; index < count; index += 1) {
    const admissionId = `history-${options.offset || 0}-${index}`;
    const decision = options.reviewAt === index ? 'review'
      : options.blockAt === index ? 'block'
        : 'allow';
    receipts.push(sealReceipt({
      receiptId: `adm-${admissionId}`,
      receiptKind: decision === 'allow' ? 'external_action_admission_receipt'
        : decision === 'review' ? 'external_action_review_receipt'
          : 'external_action_rejection_receipt',
      admissionId,
      decision,
      status: decision === 'allow' ? 'admitted' : decision === 'review' ? 'review' : 'blocked',
      createdAt: new Date(START + ((options.startIndex || 0) + index) * 2_000).toISOString(),
      metadata: { identity: receiptIdentity() },
    }));
    if (decision !== 'review' && decision !== 'block') {
      receipts.push(sealReceipt({
        receiptId: `out-${admissionId}`,
        receiptKind: 'external_action_outcome_receipt',
        admissionId,
        decision: 'allow',
        status: options.failAt === index ? 'failed' : 'executed',
        createdAt: new Date(START + ((options.startIndex || 0) + index) * 2_000 + 1_000).toISOString(),
        metadata: { identity: receiptIdentity() },
      }));
    }
  }
  return receipts;
}

function autonomyState(tier, createdAt, firstActivation = null) {
  return sealReceipt({
    receiptId: `state-${tier}-${createdAt}`,
    receiptKind: 'external_action_autonomy_state',
    admissionId: `state-${tier}`,
    createdAt,
    metadata: {
      identity: receiptIdentity(),
      autonomy: {
        schemaVersion: GRADUATED_AUTONOMY_VERSION,
        tier,
        evaluatedAt: createdAt,
        firstActivation,
      },
    },
    decision: 'allow',
    status: 'admitted',
  });
}

function humanActivation() {
  return {
    status: 'approved',
    approvalId: 'approval-human-1',
    actor: 'actor:ali',
    actorType: 'human',
    approvedAt: '2026-01-01T00:10:00.000Z',
  };
}

test('trust score reports success, violation, and review ratios', () => {
  const history = [
    ...actionReceipts(8),
    ...actionReceipts(1, { offset: 8, startIndex: 8, reviewAt: 0 }),
    ...actionReceipts(1, { offset: 9, startIndex: 9, blockAt: 0 }),
  ];
  const metrics = computeTrustScore(history, IDENTITY_REF);
  assert.equal(metrics.totalActions, 10);
  assert.equal(metrics.successes, 8);
  assert.equal(metrics.violations, 1);
  assert.equal(metrics.reviews, 1);
  assert.equal(metrics.successRate, 0.8);
  assert.equal(metrics.violationRate, 0.1);
  assert.equal(metrics.reviewRate, 0.1);
  assert.equal(metrics.score, 83);
});

test('tampered or unhashed success evidence cannot raise trust', () => {
  const valid = actionReceipts(1);
  const tampered = { ...valid[1], status: 'failed' };
  const unhashed = { ...valid[1], receiptHash: undefined, admissionId: 'forged-success' };
  const metrics = computeTrustScore([valid[0], tampered, unhashed], IDENTITY_REF);
  assert.equal(metrics.totalActions, 1);
  assert.equal(metrics.successes, 0);
  assert.equal(metrics.score, 30, 'only the valid admission remains; forged outcomes add no success');
});

test('tiers classify read, restricted write, and expanded actions', () => {
  assert.equal(requiredTierForAction({ riskCategory: 'READ_ONLY' }), 'T1');
  assert.equal(requiredTierForAction({ riskCategory: 'FILESYSTEM_WRITE' }), 'T2');
  assert.equal(requiredTierForAction({ riskCategory: 'MEMORY_WRITE' }), 'T2');
  assert.equal(requiredTierForAction({ riskCategory: 'DEPLOYMENT' }), 'T3');
  assert.equal(requiredTierForAction({ riskCategory: 'PERMISSION_CHANGE' }), 'T3');
});

test('promotion is slow and first transition requires human activation', () => {
  const history = actionReceipts(10);
  const pending = evaluateGraduatedAutonomy({
    identity: identity(),
    action: { riskCategory: 'FILESYSTEM_WRITE' },
    receipts: history,
  }, { now: () => '2026-01-01T00:20:00.000Z' });
  assert.equal(pending.autonomy.score, 100);
  assert.equal(pending.autonomy.tier, 'T1');
  assert.equal(pending.autonomy.activationRequired, true);
  assert.equal(pending.decision, 'review');
  assert.equal(pending.reason, AUTONOMY_REASONS.ACTIVATION_REQUIRED);

  const promoted = evaluateGraduatedAutonomy({
    identity: identity(),
    action: { riskCategory: 'FILESYSTEM_WRITE' },
    receipts: history,
    activation: humanActivation(),
  }, { now: () => '2026-01-01T00:20:00.000Z' });
  assert.equal(promoted.autonomy.tier, 'T2');
  assert.equal(promoted.autonomy.transition.status, 'promoted');
  assert.equal(promoted.autonomy.firstActivation.actorType, 'human');
  assert.equal(promoted.decision, 'allow');
});

test('unattested identity cannot inherit or promote autonomy', () => {
  const history = actionReceipts(30);
  const result = evaluateGraduatedAutonomy({
    identity: { identityRef: IDENTITY_REF, agentId: 'future-agent-2035', attested: false },
    action: { riskCategory: 'FILESYSTEM_WRITE' },
    receipts: history,
    activation: humanActivation(),
  }, { now: () => '2026-01-01T00:20:00.000Z' });
  assert.equal(result.autonomy.tier, 'T1');
  assert.equal(result.autonomy.attestedIdentity, false);
  assert.equal(result.reason, AUTONOMY_REASONS.ATTESTED_IDENTITY_REQUIRED);
  assert.equal(result.decision, 'review');
});

test('T3 promotion reuses the persisted first activation', () => {
  const activation = humanActivation();
  const history = [
    ...actionReceipts(30),
    autonomyState('T2', '2026-01-01T00:01:30.000Z', activation),
  ];
  const result = evaluateGraduatedAutonomy({
    identity: identity(),
    action: { riskCategory: 'DEPLOYMENT' },
    receipts: history,
  }, { now: () => '2026-01-01T00:20:00.000Z' });
  assert.equal(result.autonomy.tier, 'T3');
  assert.equal(result.autonomy.activationRequired, false);
  assert.equal(result.autonomy.transition.trigger, 'score');
  assert.equal(result.decision, 'allow');
});

test('a new critical violation demotes immediately to T1', () => {
  const activation = humanActivation();
  const stateAt = '2026-01-01T00:01:30.000Z';
  const history = [
    ...actionReceipts(30),
    autonomyState('T3', stateAt, activation),
    ...actionReceipts(1, { offset: 30, startIndex: 60, blockAt: 0 }),
  ];
  const result = evaluateGraduatedAutonomy({
    identity: identity(),
    action: { riskCategory: 'FILESYSTEM_WRITE' },
    receipts: history,
  }, { now: () => '2026-01-01T00:30:00.000Z' });
  assert.equal(result.autonomy.tier, 'T1');
  assert.equal(result.autonomy.transition.status, 'demoted');
  assert.equal(result.autonomy.transition.trigger, 'violation');
  assert.equal(result.decision, 'review');
});

test('external action guard enforces and receipts the autonomy ceiling', () => {
  const persisted = [];
  const invocation = {
    invocationId: 'autonomy-write-1',
    agentName: 'future-agent-2035',
    sessionId: 'autonomy-session',
    toolName: 'Write',
    args: { file_path: path.join(WORKSPACE_ROOT, 'autonomy-notes.md'), content: 'bounded' },
    cwd: WORKSPACE_ROOT,
    workspaceRoot: WORKSPACE_ROOT,
    workspaceId: 'default',
    identity: {
      schemaVersion: 'huqan.agent-identity-card.v1',
      agentId: 'future-agent-2035',
      agentName: 'future-agent-2035',
      ownerActorId: 'actor:ali',
      workspaceId: 'default',
      capabilities: ['file_write'],
      issuedAt: '2026-01-01T00:00:00.000Z',
    },
  };
  const result = evaluateExternalAction(invocation, {
    graduatedAutonomy: { enabled: true, receipts: actionReceipts(10), activation: humanActivation() },
    receiptWriter: { append: receipt => persisted.push(receipt) },
    now: () => '2026-01-01T00:20:00.000Z',
  });
  const finding = result.findings.find(entry => entry.gate === 'graduated-autonomy');
  assert.equal(finding.tier, 'T2');
  assert.equal(finding.decision, 'allow', 'T2 authorizes the restricted-write category ceiling');
  assert.equal(result.receipt.metadata.autonomy.tier, 'T2');
  assert.equal(result.receipt.metadata.autonomy.firstActivation.approvalId, 'approval-human-1');
  assert.match(result.receipt.receiptHash, /^[a-f0-9]{64}$/);
  assert.equal(persisted.length, 1, 'promotion state is durable before execution');

  const outcome = recordExternalActionOutcome(invocation, result.receipt, { status: 'success' }, {
    graduatedAutonomy: { enabled: true, receipts: [] },
    now: () => '2026-01-01T00:21:00.000Z',
  });
  assert.equal(outcome.receipt.metadata.autonomy.tier, 'T2', 'outcome inherits admission autonomy');
});

test('a tier transition fails closed when its receipt cannot be persisted', () => {
  const result = evaluateExternalAction({
    invocationId: 'autonomy-no-writer',
    agentName: 'future-agent-2035',
    sessionId: 'autonomy-session',
    toolName: 'Read',
    args: { file_path: path.join(WORKSPACE_ROOT, 'README.md') },
    cwd: WORKSPACE_ROOT,
    workspaceRoot: WORKSPACE_ROOT,
    workspaceId: 'default',
    identity: {
      schemaVersion: 'huqan.agent-identity-card.v1',
      agentId: 'future-agent-2035',
      agentName: 'future-agent-2035',
      ownerActorId: 'actor:ali',
      workspaceId: 'default',
      capabilities: ['file_read'],
      issuedAt: '2026-01-01T00:00:00.000Z',
    },
  }, {
    graduatedAutonomy: { enabled: true, receipts: actionReceipts(10), activation: humanActivation() },
    now: () => '2026-01-01T00:20:00.000Z',
  });
  assert.equal(result.decision, 'block');
  assert.equal(result.reason, 'external_action_receipt_persistence_failed');
  assert.match(result.receiptError, /transition requires durable receipt persistence/);
});

test('empty history starts at T1 and cannot authorize a write', () => {
  const result = evaluateGraduatedAutonomy({
    identity: identity(),
    action: { riskCategory: 'FILESYSTEM_WRITE' },
    receipts: [],
  }, { now: () => '2026-01-01T00:20:00.000Z' });
  assert.equal(result.autonomy.score, 0);
  assert.equal(result.autonomy.tier, 'T1');
  assert.equal(result.reason, AUTONOMY_REASONS.TIER_INSUFFICIENT);
  assert.equal(result.decision, 'review');
});
