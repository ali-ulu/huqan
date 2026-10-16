'use strict';

// Slice 2 of #2214 (#2115 procedure): lock the moved behaviour with a test
// that fails before the extraction, then prove it fails when the logic is
// broken. The scoring lives in lib/autonomy-trust-score.js; the facade
// re-export in lib/graduated-autonomy.js must keep importing callers green.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { computeTrustScore } = require('../lib/autonomy-trust-score');
const graduated = require('../lib/graduated-autonomy');
const { buildCanonicalReceiptPayload, hashCanonicalReceiptPayload } = require('../lib/receipt/canonical-receipt');
const { fromMcpDecision } = require('../lib/verdict/action-verdict');

const IDENTITY_REF = 'agent:default:future-agent-2035';
const START = Date.parse('2026-01-01T00:00:00.000Z');

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

function receipts(count, opts = {}) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const admissionId = `ts-${opts.offset || 0}-${i}`;
    const decision = opts.reviewAt === i ? 'review' : opts.blockAt === i ? 'block' : 'allow';
    const base = START + ((opts.startIndex || 0) + i) * 2000;
    out.push(sealReceipt({
      receiptId: `adm-${admissionId}`,
      receiptKind: decision === 'allow' ? 'external_action_admission_receipt' : decision === 'review' ? 'external_action_review_receipt' : 'external_action_rejection_receipt',
      admissionId,
      decision,
      status: decision === 'allow' ? 'admitted' : decision === 'review' ? 'review' : 'blocked',
      createdAt: new Date(base).toISOString(),
      metadata: { identity: { identityRef: IDENTITY_REF, agentId: 'future-agent-2035' } },
    }));
    if (decision === 'allow') {
      out.push(sealReceipt({
        receiptId: `out-${admissionId}`,
        receiptKind: 'external_action_outcome_receipt',
        admissionId,
        decision: 'allow',
        status: opts.failAt === i ? 'failed' : 'executed',
        createdAt: new Date(base + 1000).toISOString(),
        metadata: { identity: { identityRef: IDENTITY_REF, agentId: 'future-agent-2035' } },
      }));
    }
  }
  return out;
}

test('new module owns the scoring and the facade re-exports it', () => {
  // Both paths must be the same function so the facade is a pure delegation,
  // not a second implementation.
  assert.equal(computeTrustScore, graduated.computeTrustScore);
  assert.equal(typeof computeTrustScore, 'function');
});

test('empty trail scores 0 with no violation', () => {
  const metrics = computeTrustScore([], IDENTITY_REF);
  assert.equal(metrics.score, 0);
  assert.equal(metrics.totalActions, 0);
  assert.equal(metrics.latestViolation, null);
});

test('all successes score 100 with growing streak', () => {
  const r = receipts(5);
  const metrics = computeTrustScore(r, IDENTITY_REF);
  // 5 actions, all executed, no review/violation -> 0.7*1 + 0.2*1 + 0.1*1 = 1.0
  assert.equal(metrics.score, 100);
  assert.equal(metrics.successes, 5);
  assert.equal(metrics.violations, 0);
  assert.equal(metrics.successStreak, 5);
});

test('a violation resets streak and lowers score via the weighted formula', () => {
  // 3 successes, then a block (critical), then a success. Streak must reset.
  const r = [...receipts(3, { startIndex: 0, offset: 0 }), ...receipts(1, { blockAt: 0, offset: 3, startIndex: 3 }), ...receipts(1, { offset: 4, startIndex: 4 })];
  const metrics = computeTrustScore(r, IDENTITY_REF);
  // 5 actions: 4 successes, 1 violation, 0 reviews
  // successRate 0.8, violationRate 0.2, reviewRate 0
  // score = 100 * (0.7*0.8 + 0.2*0.8 + 0.1*1) = 100*0.82 = 82
  assert.equal(metrics.violations, 1);
  assert.equal(metrics.successStreak, 1);
  assert.equal(metrics.score, 82);
  assert.equal(metrics.latestViolation.critical, true);
});

test('reviews are counted and dilute the score with 0.1 weight', () => {
  const r = [...receipts(2, { startIndex: 0, offset: 0 }), ...receipts(1, { reviewAt: 0, offset: 2, startIndex: 2 }), ...receipts(2, { offset: 3, startIndex: 3 })];
  const metrics = computeTrustScore(r, IDENTITY_REF);
  // 5 actions: 4 successes, 0 violations, 1 review -> successRate 0.8, violationRate 0, reviewRate 0.2
  // score = 100*(0.7*0.8 +0.2*1 +0.1*0.8)=84
  assert.equal(metrics.reviews, 1);
  assert.equal(metrics.score, 84);
});
