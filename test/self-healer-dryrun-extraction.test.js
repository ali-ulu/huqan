'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const runner = require('../lib/self-healer/dryrun-runner');
const projections = require('../lib/self-healer/dryrun-projections');
const { evaluateDryRunBudget } = require('../lib/self-healer/dryrun-budget-gate');

// The runner re-exports the same public surface after the split: the two
// jobs it keeps are orchestration and the AB10 budget gate; the durable
// projections moved to dryrun-projections.js under the same names.

test('dryrun runner re-exports the extracted projection constants', () => {
  assert.equal(runner.SELF_HEALER_DRYRUN_VERSION, projections.SELF_HEALER_DRYRUN_VERSION);
  assert.equal(runner.SELF_HEALER_DRYRUN_MODE, projections.SELF_HEALER_DRYRUN_MODE);
  assert.deepEqual(runner.RISK_SCORE_BY_SEVERITY, projections.RISK_SCORE_BY_SEVERITY);
  assert.equal(Object.isFrozen(runner.RISK_SCORE_BY_SEVERITY), true);
});

test('extracted projections keep the moved function behaviour', () => {
  assert.equal(projections.requestedVerdictFor('block'), 'block');
  assert.equal(projections.requestedVerdictFor('require_review'), 'review');
  assert.equal(projections.requestedVerdictFor('propose'), 'review');

  assert.match(projections.createRunId({ a: 1 }), /^shrun_[0-9a-f]{16}$/);
  assert.equal(projections.createRunId({ a: 1 }), projections.createRunId({ a: 1 }));
  assert.notEqual(projections.createRunId({ a: 1 }), projections.createRunId({ a: 2 }));

  assert.equal(projections.riskScoreForSeverity('critical'), 95);
  assert.equal(projections.riskScoreForSeverity('CRITICAL'), 95);
  assert.equal(projections.riskScoreForSeverity('unknown-severity'), 50);

  const finding = {
    findingId: 'f1',
    kind: 'stale_docs',
    severity: 'info',
    title: 't',
    summary: 's',
    affectedFiles: ['docs/a.md'],
    suggestedTests: ['test/a.test.js'],
    suggestedFix: { summary: 'reword' },
    evidence: [{ type: 'file', ref: 'docs/a.md', detail: 'd' }],
  };
  const decisionResult = {
    decision: 'require_review',
    reason: 'require_review',
    riskFlags: ['runtime_mutation'],
    allowedNextSteps: ['human_review'],
    requiresApproval: true,
  };
  const context = {
    runId: 'shrun_x',
    workspaceId: 'ws1',
    agentId: 'self-healer',
    actor: 'self-healer',
    owner: 'human_reviewer',
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  const payload = projections.buildActionPayload(finding, decisionResult);
  assert.equal(payload.patchIncluded, false);
  assert.equal(payload.applied, false);
  assert.deepEqual(payload.affectedFiles, ['docs/a.md']);
  assert.equal(payload.suggestedFixSummary, 'reword');

  const approval = projections.buildProposalApprovalRequest(finding, decisionResult, context);
  assert.equal(approval.ok, true);
  assert.equal(approval.request.workspaceId, 'ws1');
  assert.match(approval.request.approvalId, /^sha_[0-9a-f]{16}$/);
  assert.equal(projections.buildProposalApprovalRequest(finding, { ...decisionResult, requiresApproval: false }, context), null);

  const receipt = projections.buildReceiptSummary(finding, decisionResult, context);
  assert.match(receipt.receiptId, /^shr_[0-9a-f]{16}$/);
  assert.equal(receipt.receiptKind, 'self_healer_dryrun_summary');
  assert.equal(receipt.scopeSummary.applied, false);
});

test('the extracted budget gate keeps the AB10 stop semantics', () => {
  // block: usage crosses the ceiling, nothing is processed
  const blocked = evaluateDryRunBudget({ findingCount: 2, iterationsUsed: 199, maxIterationsPerWindow: 200 });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.budget.decision, 'block');
  assert.equal(blocked.processCount, 0);
  assert.equal(blocked.usageKnown, true);

  // review: near the ceiling, only the remaining budget is processed
  const review = evaluateDryRunBudget({ findingCount: 5, iterationsUsed: 159, maxIterationsPerWindow: 200 });
  assert.equal(review.blocked, false);
  assert.equal(review.budgetReviewRequired, true);
  assert.equal(review.processCount, Math.min(Math.floor(review.budget.remaining), 5));
  assert.equal(review.processCount, 5);
  // remaining (41) exceeds the finding count, so nothing is actually truncated
  assert.equal(review.budgetTruncated, false);

  // a run large enough to exceed the ceiling blocks outright instead of
  // truncating: requestedIterations rides on findingCount, so a non-blocked
  // review always has remaining >= findingCount and truncation stays false
  const huge = evaluateDryRunBudget({ findingCount: 50, iterationsUsed: 159, maxIterationsPerWindow: 200 });
  assert.equal(huge.blocked, true);
  assert.equal(huge.processCount, 0);

  // allow: within budget, everything is processed
  const allow = evaluateDryRunBudget({ findingCount: 3, iterationsUsed: 0, maxIterationsPerWindow: 200 });
  assert.equal(allow.blocked, false);
  assert.equal(allow.budgetReviewRequired, false);
  assert.equal(allow.processCount, 3);
  assert.equal(allow.budgetTruncated, false);

  // unmeasured usage is reported, never silently read as zero
  const unknown = evaluateDryRunBudget({ findingCount: 1 });
  assert.equal(unknown.usageKnown, false);
  for (const bad of [null, undefined, '', 'lots', NaN]) {
    assert.equal(evaluateDryRunBudget({ findingCount: 1, iterationsUsed: bad }).usageKnown, false,
      `${String(bad)} must not read as measured usage`);
  }
  assert.equal(evaluateDryRunBudget({ findingCount: 1, iterationsUsed: '7' }).usageKnown, true);
});

test('the split runner still produces the same frozen run shape', () => {
  const finding = {
    kind: 'security',
    title: 'Route lacks a gate',
    summary: 'mutating route has no gate',
    severity: 'high',
    evidence: [{ type: 'route', ref: 'server.js', detail: 'no gate' }],
    affectedFiles: ['server.js'],
    riskFlags: ['runtime_mutation'],
  };
  const r = runner.runSelfHealerDryRun({ findings: [finding] });

  assert.equal(r.ok, true);
  assert.equal(r.applied, false);
  assert.equal(r.mode, projections.SELF_HEALER_DRYRUN_MODE);
  assert.equal(r.blockedByBudget, false);
  assert.ok(Object.isFrozen(r));
  assert.equal(r.proposals.length, 1);

  const p = r.proposals[0];
  assert.equal(p.applied, false);
  assert.equal(p.approvalRequest.requestedVerdict, 'review');
  assert.equal(p.approvalRequest.actionPayload.patchIncluded, false);
  assert.equal(p.receiptSummary.receiptKind, 'self_healer_dryrun_summary');
});
