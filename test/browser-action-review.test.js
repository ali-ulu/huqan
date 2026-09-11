'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildExternalActionAdmissionReceipt,
  buildExternalActionOutcomeReceipt,
  buildExternalActionOutcomeReviewReceipt,
  createJsonlExternalActionReceiptWriter,
  latestExternalActionReview,
} = require('../lib/external-action-receipt');
const { recordExternalActionReview } = require('../lib/external-action-guard');
const { normalizeExternalActionEnvelope } = require('../lib/external-action-envelope');

function outcomeFixture() {
  const envelope = normalizeExternalActionEnvelope({
    invocationId: 'inv-review-1',
    agent: { name: 'claude-code', version: '1.0.0' },
    session: { id: 'sess-review-1', turnId: 'turn-1' },
    tool: { name: 'browser_navigate', kind: 'network' },
    args: { url: 'https://example.com/report' },
    workspaceId: 'ws-review',
  });
  const admission = buildExternalActionAdmissionReceipt(
    envelope,
    { decision: 'allow', reason: 'permitted', risk: { score: 12 }, findings: [] },
    { now: () => '2026-09-11T21:00:00.000Z' },
  );
  const outcome = buildExternalActionOutcomeReceipt(
    envelope,
    admission,
    { status: 'success', reason: 'browser_tool_reported_success', output: { content: 'PAGE DIGEST ONLY' } },
    { now: () => '2026-09-11T21:00:01.000Z' },
  );
  return { envelope, admission, outcome };
}

describe('buildExternalActionOutcomeReviewReceipt', () => {
  it('carries reviewDecision, reviewActor and reviewAt bound to the outcome', () => {
    const { outcome } = outcomeFixture();
    const review = buildExternalActionOutcomeReviewReceipt(outcome, {
      decision: 'approved',
      actor: 'ali',
      note: 'page matches the admitted destination',
    }, { now: () => '2026-09-11T21:05:00.000Z' });

    assert.equal(review.receiptKind, 'external_action_outcome_review_receipt');
    assert.equal(review.status, 'reviewed');
    assert.equal(review.metadata.reviewDecision, 'approved');
    assert.equal(review.metadata.reviewActor, 'ali');
    assert.equal(review.metadata.reviewAt, '2026-09-11T21:05:00.000Z');
    assert.equal(review.metadata.outcomeReceiptId, outcome.receiptId);
    assert.equal(review.metadata.outcomeReceiptHash, outcome.receiptHash);
    assert.equal(review.metadata.actionActor, outcome.actor);
    assert.equal(review.metadata.note, 'page matches the admitted destination');
    // The chain stays queryable from the review itself.
    assert.equal(review.admissionId, outcome.admissionId);
    assert.equal(review.workspaceId, outcome.workspaceId);
    assert.equal(review.provenanceId, outcome.provenanceId);
    assert.equal(review.agentId, outcome.agentId);
    assert.equal(review.trustPolicyVersion, outcome.trustPolicyVersion);
    assert.equal(review.createdAt, review.metadata.reviewAt);
  });

  it('re-verifies its own hash from the stored canonical fields', () => {
    const { outcome } = outcomeFixture();
    const review = buildExternalActionOutcomeReviewReceipt(outcome, { decision: 'approved', actor: 'ali' });
    const { receiptHash, ...canonicalSource } = review;

    assert.equal(typeof receiptHash, 'string');
    assert.ok(receiptHash.length > 0);
    const rebuilt = JSON.parse(JSON.stringify(review));
    delete rebuilt.receiptHash;
    const { buildCanonicalReceiptPayload, hashCanonicalReceiptPayload } = require('../lib/receipt/canonical-receipt');
    const { fromMcpDecision } = require('../lib/verdict/action-verdict');
    const verdict = fromMcpDecision({ decision: rebuilt.decision, reason: rebuilt.reason }).verdict;
    assert.equal(hashCanonicalReceiptPayload(buildCanonicalReceiptPayload(rebuilt, { verdict })), receiptHash);
    assert.equal(canonicalSource.status, 'reviewed');
  });
});

describe('review decisions speak the canonical verdict vocabulary', () => {
  it('maps approved to allow, rejected to block and escalated to review', () => {
    const { outcome } = outcomeFixture();
    const expectations = { approved: 'allow', rejected: 'block', escalated: 'review' };
    let second = 0;
    for (const [reviewDecision, expectedDecision] of Object.entries(expectations)) {
      const review = buildExternalActionOutcomeReviewReceipt(
        outcome,
        { decision: reviewDecision, actor: 'ali' },
        { now: () => `2026-09-11T21:06:0${second++}.000Z` },
      );
      assert.equal(review.decision, expectedDecision, reviewDecision);
      assert.equal(review.reason, `outcome_review_${reviewDecision}`);
    }
  });

  it('refuses anything but a hashed outcome receipt and a named reviewer', () => {
    const { admission, outcome } = outcomeFixture();
    assert.throws(() => buildExternalActionOutcomeReviewReceipt(admission, { decision: 'approved', actor: 'ali' }));
    assert.throws(() => buildExternalActionOutcomeReviewReceipt(null, { decision: 'approved', actor: 'ali' }));

    const tampered = { ...outcome, workspaceId: 'ws-other' };
    assert.throws(() => buildExternalActionOutcomeReviewReceipt(tampered, { decision: 'approved', actor: 'ali' }),
      /hash does not verify/);
    const unsigned = { ...outcome };
    delete unsigned.receiptHash;
    assert.throws(() => buildExternalActionOutcomeReviewReceipt(unsigned, { decision: 'approved', actor: 'ali' }));

    assert.throws(() => buildExternalActionOutcomeReviewReceipt(outcome, { decision: 'maybe', actor: 'ali' }));
    assert.throws(() => buildExternalActionOutcomeReviewReceipt(outcome, { decision: 'approved' }));
    assert.throws(() => buildExternalActionOutcomeReviewReceipt(outcome, { decision: 'approved', actor: '   ' }));
  });
});

describe('recordExternalActionReview', () => {
  it('persists through the same writer contract and reports failure fail-closed', () => {
    const { outcome } = outcomeFixture();
    const written = [];
    const writer = Object.assign(receipt => { written.push(receipt); return true; }, { path: 'memory://trail' });
    const result = recordExternalActionReview(outcome, { decision: 'approved', actor: 'ali' }, {
      now: () => '2026-09-11T21:07:00.000Z',
      receiptWriter: writer,
    });

    assert.equal(result.ok, true);
    assert.equal(result.receiptPersisted, true);
    assert.equal(result.receiptError, null);
    assert.equal(written.length, 1);
    assert.equal(written[0].receiptKind, 'external_action_outcome_review_receipt');
    assert.equal(written[0].metadata.reviewDecision, 'approved');

    const failing = recordExternalActionReview(outcome, { decision: 'approved', actor: 'ali' }, {
      now: () => '2026-09-11T21:07:01.000Z',
      receiptWriter: () => { throw new Error('disk full'); },
    });
    assert.equal(failing.ok, false);
    assert.equal(failing.receiptPersisted, false);
    assert.match(failing.receiptError, /disk full/);
    assert.equal(failing.receipt.receiptKind, 'external_action_outcome_review_receipt');

    const invalid = recordExternalActionReview(outcome, { decision: 'maybe', actor: 'ali' }, { receiptWriter: writer });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.receipt, null);
    assert.match(invalid.receiptError, /review\.decision/);
  });

  it('lands the review in the JSONL trail beside the outcome', t => {
    const { outcome } = outcomeFixture();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-outcome-review-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    const writer = createJsonlExternalActionReceiptWriter({ path: path.join(root, 'receipts.jsonl') });

    const first = recordExternalActionReview(outcome, { decision: 'escalated', actor: 'ali' }, {
      now: () => '2026-09-11T21:08:00.000Z', receiptWriter: writer,
    });
    assert.equal(first.ok, true);
    const latest = latestExternalActionReview(writer.path, outcome.receiptId);
    assert.equal(latest.metadata.reviewDecision, 'escalated');
    assert.equal(latest.receiptId, first.receipt.receiptId);
  });
});

describe('latestExternalActionReview', () => {
  it('returns the newest verifying review for an outcome and skips corruption', t => {
    const { outcome } = outcomeFixture();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-outcome-review-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    const receiptPath = path.join(root, 'receipts.jsonl');
    const writer = createJsonlExternalActionReceiptWriter({ path: receiptPath });

    assert.equal(latestExternalActionReview(receiptPath, outcome.receiptId), null);

    const approved = buildExternalActionOutcomeReviewReceipt(outcome, { decision: 'approved', actor: 'ali' },
      { now: () => '2026-09-11T21:09:00.000Z' });
    const rejected = buildExternalActionOutcomeReviewReceipt(outcome, { decision: 'rejected', actor: 'ayse' },
      { now: () => '2026-09-11T21:09:01.000Z' });
    writer.append(approved);
    writer.append(rejected);

    assert.equal(latestExternalActionReview(receiptPath, outcome.receiptId).metadata.reviewDecision, 'rejected');
    assert.equal(latestExternalActionReview(receiptPath, 'xact_out_missing'), null);
    assert.throws(() => latestExternalActionReview(receiptPath, '  '));

    // A tampered line is corruption, not a newer review: appending a doctored
    // "approval" cannot overturn the newest review that still verifies.
    const tampered = { ...rejected, metadata: { ...rejected.metadata, reviewDecision: 'approved', reviewActor: 'attacker' } };
    fs.appendFileSync(receiptPath, `${JSON.stringify(tampered)}\n`);
    fs.appendFileSync(receiptPath, 'not json at all\n');
    const afterCorruption = latestExternalActionReview(receiptPath, outcome.receiptId);
    assert.equal(afterCorruption.metadata.reviewDecision, 'rejected');
    assert.equal(afterCorruption.metadata.reviewActor, 'ayse');
  });
});