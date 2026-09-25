'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildCanonicalReceiptPayload, hashCanonicalReceiptPayload } = require('../lib/receipt/canonical-receipt');
const { fromMcpDecision } = require('../lib/verdict/action-verdict');
const {
  normalizeThresholds,
  projectSessionThresholds,
} = require('../scripts/replay-impact-thresholds');

let sequence = 0;

function sealed({ sessionId = 's1', score, kind = 'external_action_admission_receipt' } = {}) {
  sequence += 1;
  const metadata = { sessionId };
  if (score !== undefined) metadata.justification = { blastRadius: { score } };
  const receipt = {
    receiptId: `adm-replay-${sequence}`,
    receiptKind: kind,
    decision: 'allow',
    status: 'admitted',
    admissionId: `replay-${sequence}`,
    workspaceId: 'default',
    actor: 'replay-agent',
    agentId: 'replay-agent',
    memoryDraftId: 'not_applicable',
    provenanceId: 'external:replay-agent:history',
    trustPolicyVersion: 'huqan-external-action-guard-v1',
    approvalId: 'not_applicable',
    approvalStatus: 'not_required',
    reason: 'history',
    riskScore: 0,
    createdAt: new Date(Date.parse('2026-01-01T00:00:00.000Z') + sequence * 1000).toISOString(),
    metadata,
  };
  const canonical = buildCanonicalReceiptPayload(receipt, { verdict: fromMcpDecision({ decision: 'allow', reason: 'history' }).verdict });
  return { ...canonical, receiptHash: hashCanonicalReceiptPayload(canonical) };
}

const BANDS = Object.freeze({ reviewAt: 100, quorumAt: 200, blockAt: 300 });

test('projected verdicts use the cumulative total including the proposed action', () => {
  const report = projectSessionThresholds(
    [sealed({ score: 40 }), sealed({ score: 70 }), sealed({ score: 200 })],
    BANDS,
  );
  const steps = report.sessions.s1.steps;
  assert.equal(steps[0].verdict, 'allow');
  assert.equal(steps[0].cumulative, 40);
  assert.equal(steps[1].verdict, 'review');
  assert.equal(steps[1].cumulative, 110);
  assert.equal(steps[2].verdict, 'block');
  assert.equal(steps[2].cumulative, 310);
  assert.deepEqual(
    [report.totals.wouldAllow, report.totals.wouldReview, report.totals.wouldQuorum, report.totals.wouldBlock],
    [1, 1, 0, 1],
  );
});

test('equality triggers the stated band', () => {
  const report = projectSessionThresholds([sealed({ score: 100 })], BANDS);
  assert.equal(report.sessions.s1.steps[0].verdict, 'review');
  const quorum = projectSessionThresholds([sealed({ score: 100 }), sealed({ score: 100 })], BANDS);
  assert.equal(quorum.sessions.s1.steps[1].verdict, 'quorum');
});

test('unscored actions are unknown and unverified receipts are excluded, never zeroed', () => {
  const good = sealed({ score: 40 });
  const unscored = sealed({});
  const tampered = { ...sealed({ score: 90 }), receiptHash: '0'.repeat(64) };
  const outcome = sealed({ score: 50, kind: 'external_action_outcome_receipt' });
  const report = projectSessionThresholds([good, unscored, tampered, outcome], BANDS);
  assert.equal(report.totals.actions, 2);
  assert.equal(report.totals.scored, 1);
  assert.equal(report.totals.unscored, 1);
  assert.equal(report.excluded.unverifiedExcluded, 1);
  assert.equal(report.excluded.nonAdmissionExcluded, 1);
  assert.equal(report.sessions.s1.steps[1].verdict, 'unknown');
  assert.equal(report.sessions.s1.steps[1].cumulative, 40, 'unknown adds nothing to the total');
});

test('sessions replay independently and one can be selected', () => {
  const receipts = [sealed({ sessionId: 'a', score: 250 }), sealed({ sessionId: 'b', score: 10 })];
  const report = projectSessionThresholds(receipts, BANDS);
  assert.equal(report.totals.sessions, 2);
  assert.equal(report.sessions.a.steps[0].verdict, 'quorum');
  assert.equal(report.sessions.b.steps[0].verdict, 'allow');
  const only = projectSessionThresholds(receipts, BANDS, { sessionId: 'b' });
  assert.deepEqual(Object.keys(only.sessions), ['b']);
});

test('threshold policy stays out of code: unordered, negative or missing bands throw', () => {
  for (const bands of [
    { reviewAt: 200, quorumAt: 100, blockAt: 300 },
    { reviewAt: -1, quorumAt: 100, blockAt: 300 },
    { reviewAt: 100, quorumAt: 100 },
    null,
    [],
  ]) {
    assert.throws(() => normalizeThresholds(bands), /must be|must order/);
    assert.throws(() => projectSessionThresholds([], bands), /must be|must order/);
  }
  assert.deepEqual(Object.keys(normalizeThresholds(BANDS)), ['reviewAt', 'quorumAt', 'blockAt']);
});

test('the replay is deterministic and frozen', () => {
  const receipts = [sealed({ score: 40 }), sealed({})];
  const first = projectSessionThresholds(receipts, BANDS);
  const second = projectSessionThresholds(receipts, BANDS);
  assert.deepEqual(first, second);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.sessions.s1));
});
