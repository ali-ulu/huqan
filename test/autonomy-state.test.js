'use strict';

// Slice 3 of #2214 (#2115 procedure): lock tier-policy and state readings that
// moved to lib/autonomy-state.js. The facade in lib/graduated-autonomy.js
// must stay a pure delegation, not a second implementation.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const state = require('../lib/autonomy-state');
const graduated = require('../lib/graduated-autonomy');
const { buildCanonicalReceiptPayload, hashCanonicalReceiptPayload } = require('../lib/receipt/canonical-receipt');
const { fromMcpDecision } = require('../lib/verdict/action-verdict');

const IDENTITY_REF = 'agent:default:future-agent-2035';

function sealAutonomyReceipt(overrides = {}) {
  const base = {
    workspaceId: 'default',
    actor: 'future-agent-2035',
    agentId: 'future-agent-2035',
    memoryDraftId: 'not_applicable',
    provenanceId: 'external:future-agent-2035:history',
    trustPolicyVersion: 'huqan-external-action-guard-v1',
    approvalId: 'not_applicable',
    approvalStatus: 'not_required',
    reason: 'admitted',
    riskScore: 0,
    receiptId: 'aut-1',
    receiptKind: 'external_action_admission_receipt',
    admissionId: 'adm-aut-1',
    decision: 'allow',
    status: 'admitted',
    createdAt: '2026-01-01T00:00:00.000Z',
    metadata: {
      identity: { identityRef: IDENTITY_REF, agentId: 'future-agent-2035' },
      autonomy: { schemaVersion: 'huqan.graduated-autonomy.v1', tier: 'T2', evaluatedAt: '2026-01-01T00:00:00.000Z', firstActivation: { approvalId: 'a1', actor: 'ali', actorType: 'human', approvedAt: '2026-01-01T00:00:00.000Z' } },
    },
    ...overrides,
  };
  const canonical = buildCanonicalReceiptPayload(base, {
    verdict: fromMcpDecision({ decision: base.decision, reason: base.reason }).verdict,
  });
  return { ...canonical, receiptHash: hashCanonicalReceiptPayload(canonical) };
}

test('new module owns tier policy and facade re-exports it', () => {
  assert.equal(state.requiredTierForAction, graduated.requiredTierForAction);
  assert.equal(state.latestAutonomyState, graduated.latestAutonomyState);
  assert.equal(state.AUTONOMY_TIERS, graduated.AUTONOMY_TIERS);
});

test('requiredTierForAction maps categories to the documented tiers', () => {
  assert.equal(state.requiredTierForAction({ riskCategory: 'READ_ONLY' }), 'T1');
  assert.equal(state.requiredTierForAction({ riskCategory: 'filesystem_write' }), 'T2');
  assert.equal(state.requiredTierForAction({ riskCategory: 'network_write' }), 'T3');
  assert.equal(state.requiredTierForAction({}), 'T3');
});

test('latestAutonomyState falls back to T1 when no autonomy receipt exists', () => {
  const result = state.latestAutonomyState([], IDENTITY_REF);
  assert.equal(result.tier, 'T1');
  assert.equal(result.evaluatedAt, null);
});

test('latestAutonomyState reads the newest autonomy receipt for the identity', () => {
  const older = sealAutonomyReceipt({ createdAt: '2026-01-01T00:00:00.000Z', metadata: { identity: { identityRef: IDENTITY_REF }, autonomy: { schemaVersion: 'huqan.graduated-autonomy.v1', tier: 'T1', evaluatedAt: '2026-01-01T00:00:00.000Z' } } });
  const newer = sealAutonomyReceipt({ receiptId: 'aut-2', admissionId: 'adm-aut-2', createdAt: '2026-01-02T00:00:00.000Z', metadata: { identity: { identityRef: IDENTITY_REF }, autonomy: { schemaVersion: 'huqan.graduated-autonomy.v1', tier: 'T3', evaluatedAt: '2026-01-02T00:00:00.000Z' } } });
  const result = state.latestAutonomyState([older, newer], IDENTITY_REF);
  assert.equal(result.tier, 'T3');
  assert.equal(result.evaluatedAt, '2026-01-02T00:00:00.000Z');
});

test('promotionEligible respects score, actions and streak thresholds', () => {
  assert.equal(state.promotionEligible('T1', { score: 75, totalActions: 10, successStreak: 5 }), true);
  assert.equal(state.promotionEligible('T1', { score: 74, totalActions: 10, successStreak: 5 }), false);
  assert.equal(state.promotionEligible('T2', { score: 90, totalActions: 30, successStreak: 10 }), true);
  assert.equal(state.promotionEligible('T2', { score: 90, totalActions: 29, successStreak: 10 }), false);
});

test('demotionTarget prefers violation over score and respects critical flag', () => {
  const critical = { latestViolation: { createdAt: '2026-01-02T00:00:00.000Z', critical: true }, score: 95 };
  const nonCritical = { latestViolation: { createdAt: '2026-01-02T00:00:00.000Z', critical: false }, score: 95 };
  const stateAt = { evaluatedAt: '2026-01-01T00:00:00.000Z' };
  assert.equal(state.demotionTarget('T2', critical, stateAt), 'T1');
  assert.equal(state.demotionTarget('T3', nonCritical, stateAt), 'T2');
  // score-based demotion without violation
  assert.equal(state.demotionTarget('T3', { score: 70, latestViolation: null }, { evaluatedAt: '2026-01-03T00:00:00.000Z' }), 'T2');
  assert.equal(state.demotionTarget('T3', { score: 50, latestViolation: null }, { evaluatedAt: '2026-01-03T00:00:00.000Z' }), 'T1');
});
