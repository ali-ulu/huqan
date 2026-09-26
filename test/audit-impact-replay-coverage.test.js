'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCoverageAudit } = require('../scripts/audit-impact-replay-coverage');
const { buildCanonicalReceiptPayload, hashCanonicalReceiptPayload } = require('../lib/receipt/canonical-receipt');
const { fromMcpDecision } = require('../lib/verdict/action-verdict');

function receipt({ at, score, sessionId, runId, kind = 'external_action_admission_receipt' }) {
  const metadata = { sessionId, runId };
  if (score !== undefined) metadata.justification = { blastRadius: { score } };
  const item = {
    receiptId: `coverage-${at}`,
    receiptKind: kind,
    decision: 'allow',
    status: 'admitted',
    admissionId: `coverage-${at}`,
    workspaceId: 'default',
    actor: 'coverage-agent',
    agentId: 'coverage-agent',
    memoryDraftId: 'not_applicable',
    provenanceId: 'external:coverage-agent:history',
    trustPolicyVersion: 'huqan-external-action-guard-v1',
    approvalId: 'not_applicable',
    approvalStatus: 'not_required',
    reason: 'history',
    riskScore: 0,
    createdAt: at,
    metadata,
  };
  const canonical = buildCanonicalReceiptPayload(item, {
    verdict: fromMcpDecision({ decision: 'allow', reason: 'history' }).verdict,
  });
  return { ...canonical, receiptHash: hashCanonicalReceiptPayload(canonical) };
}

test('coverage reports verified window admissions without exposing identifiers', () => {
  const audit = createCoverageAudit('2026-09-27T00:00:00.000Z');
  audit.addLine(JSON.stringify(receipt({ at: '2026-09-02T00:00:00.000Z', sessionId: 'secret-session' })));
  audit.addLine(JSON.stringify(receipt({ at: '2026-09-26T10:00:00.000Z', score: 50, sessionId: 'secret-session', runId: 'secret-run' })));
  audit.addLine(JSON.stringify(receipt({ at: '2026-08-20T00:00:00.000Z', score: 80 })));
  const report = audit.finish();
  assert.equal(report.counts.admissionReceipts, 3);
  assert.equal(report.counts.admissionOutsideWindow, 1);
  assert.equal(report.counts.windowAdmissions, 2);
  assert.equal(report.counts.withScore, 1);
  assert.equal(report.counts.missingScore, 1);
  assert.equal(report.counts.withSessionId, 2);
  assert.equal(report.counts.withRunId, 1);
  assert.equal(report.window.dailyAdmissions.length, 31, 'a rolling 30-day window touches both endpoint dates');
  assert.equal(report.window.dailyAdmissions.find((day) => day.date === '2026-09-26').count, 1);
  assert.ok(!JSON.stringify(report).includes('secret-session'));
  assert.ok(!JSON.stringify(report).includes('secret-run'));
});

test('malformed, unsealed and non-admission records cannot improve coverage', () => {
  const audit = createCoverageAudit('2026-09-27T00:00:00.000Z');
  audit.addLine('{bad json');
  audit.addLine('[]');
  audit.addLine(JSON.stringify({ createdAt: 'invalid' }));
  audit.addLine(JSON.stringify({ ...receipt({ at: '2026-09-26T00:00:00.000Z', score: 30 }), receiptHash: '0'.repeat(64) }));
  audit.addLine(JSON.stringify(receipt({ at: '2026-09-26T01:00:00.000Z', kind: 'external_action_outcome_receipt' })));
  audit.addLine(JSON.stringify(receipt({ at: '2026-09-26T02:00:00.000Z', score: -1 })));
  const report = audit.finish();
  assert.equal(report.counts.malformedJson, 1);
  assert.equal(report.counts.nonObject, 1);
  assert.equal(report.counts.invalidTimestamp, 1);
  assert.equal(report.counts.hashMismatch, 1);
  assert.equal(report.counts.hashMatchingReceipts, 2);
  assert.equal(report.counts.windowAdmissions, 1);
  assert.equal(report.counts.invalidScore, 1);
  assert.equal(report.counts.withScore, 0);
});

test('invalid audit time fails closed', () => {
  assert.throws(() => createCoverageAudit('not-a-date'), /asOf must be an ISO timestamp/);
});
