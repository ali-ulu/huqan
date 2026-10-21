'use strict';

/**
 * #4135 â€” the Usage doctor check: local usage and approval-fatigue signal.
 *
 * These tests are fully offline and dependency-injected: no SQLite backend and
 * no real filesystem state is required, which is also how the check shows it
 * makes no network call â€” everything it reads arrives through local readers.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  checkUsage,
  summarizeGateEvents,
  USAGE_WINDOW_DAYS,
  RAPID_APPROVAL_MS,
  RAPID_APPROVAL_RATIO_WARN,
  MIN_DECIDED_FOR_RATIO_WARN,
} = require('../lib/cli-doctor-usage');

const NOW = Date.parse('2026-10-21T12:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

function admissionReceipt({ decision = 'allow', agentType = 'codex', ageMs = 0 }) {
  const kind = decision === 'allow'
    ? 'external_action_admission_receipt'
    : decision === 'review'
      ? 'external_action_review_receipt'
      : 'external_action_rejection_receipt';
  return {
    receiptKind: kind,
    decision,
    createdAt: iso(ageMs),
    metadata: { host: { agentType }, agentName: 'test-agent' },
  };
}

function approvalRow({ createdMsAgo, decidedMsAgo = null, decision = 'approved' }) {
  return {
    created_at: NOW - createdMsAgo,
    decided_at: decidedMsAgo === null ? 0 : NOW - decidedMsAgo,
    status: decidedMsAgo === null ? 'pending' : 'decided',
    decision: decidedMsAgo === null ? '' : decision,
  };
}

test('usage thresholds are named exported constants (#4135)', () => {
  assert.equal(USAGE_WINDOW_DAYS, 7);
  assert.equal(typeof RAPID_APPROVAL_MS, 'number');
  assert.ok(RAPID_APPROVAL_RATIO_WARN > 0 && RAPID_APPROVAL_RATIO_WARN < 1);
  assert.ok(MIN_DECIDED_FOR_RATIO_WARN >= 1);
});

test('gate events are counted with decision and host-reported identity split (#4135)', () => {
  const gate = summarizeGateEvents({
    now: NOW,
    receipts: [
      admissionReceipt({ decision: 'allow', agentType: 'codex' }),
      admissionReceipt({ decision: 'allow', agentType: 'codex', ageMs: 1000 }),
      admissionReceipt({ decision: 'review', agentType: 'claude-code' }),
      admissionReceipt({ decision: 'blocked', agentType: 'codex', ageMs: 8 * 24 * 60 * 60 * 1000 }),
      { receiptKind: 'external_action_outcome_receipt', createdAt: iso(0) },
    ],
  });

  assert.equal(gate.total, 3);
  assert.deepEqual(gate.byDecision, { allow: 2, review: 1, blocked: 0 });
  assert.deepEqual(gate.byProfile, { codex: 2, 'claude-code': 1 });
});

test('the REVIEW/ALLOW ratio is null without ALLOW and numeric with it (#4135)', () => {
  const noAllow = summarizeGateEvents({ now: NOW, receipts: [admissionReceipt({ decision: 'blocked' })] });
  assert.equal(noAllow.reviewAllowRatio, null);

  const mixed = summarizeGateEvents({
    now: NOW,
    receipts: [
      admissionReceipt({ decision: 'allow' }),
      admissionReceipt({ decision: 'allow' }),
      admissionReceipt({ decision: 'review' }),
      admissionReceipt({ decision: 'blocked' }),
    ],
  });
  assert.equal(mixed.reviewAllowRatio, 0.5);

  const result = checkUsage(
    { now: NOW },
    { readReceipts: () => ({ receipts: [], trailExists: true }), readApprovals: () => [] },
  );
  assert.match(result.detail, /REVIEW\/ALLOW n\/a/);
  assert.equal(result.usage.gate.reviewAllowRatio, null);
});

test('an installed profile with no gate event raises the silent-profile warning (#4135)', () => {
  const result = checkUsage(
    { now: NOW },
    {
      readReceipts: () => ({
        receipts: [admissionReceipt({ decision: 'allow', agentType: 'codex' })],
        trailExists: true,
      }),
      readApprovals: () => [],
      readInstalledProfiles: () => ['codex', 'claude-code'],
    },
  );

  assert.deepEqual(result.usage.silentProfiles, ['claude-code']);
  assert.ok(
    result.warnings.some((warning) => /Installed gate profile\(s\) claude-code had no gate event/.test(warning)),
    `expected the silent-profile warning, got: ${JSON.stringify(result.warnings)}`,
  );
});

test('an active installed profile raises no silent-profile warning (#4135)', () => {
  const result = checkUsage(
    { now: NOW },
    {
      readReceipts: () => ({
        receipts: [admissionReceipt({ decision: 'allow', agentType: 'codex' })],
        trailExists: true,
      }),
      readApprovals: () => [],
      readInstalledProfiles: () => ['codex'],
    },
  );

  assert.deepEqual(result.usage.silentProfiles, []);
  assert.ok(!result.warnings.some((warning) => /Installed gate profile/.test(warning)));
});

test('an unreadable installed-profile inventory is a warning, not a failed verdict (#4135)', () => {
  const error = new Error('gate status unavailable');
  error.code = 'GATE_STATUS_UNAVAILABLE';
  const result = checkUsage(
    { now: NOW },
    {
      readReceipts: () => ({ receipts: [admissionReceipt({ decision: 'allow' })], trailExists: true }),
      readApprovals: () => [],
      readInstalledProfiles: () => { throw error; },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.usage.installedProfiles, null);
  assert.ok(
    result.warnings.some((warning) => /Installed gate profiles could not be read/.test(warning)),
    `expected the unreadable-inventory warning, got: ${JSON.stringify(result.warnings)}`,
  );
});

test('a gate with no trail warns that nothing is governed yet (#4135)', () => {
  const result = checkUsage(
    { now: NOW, receiptPath: 'Z:/definitely-not-here/external-action-receipts.jsonl' },
    { readApprovals: () => [] },
  );

  assert.equal(result.ok, true, 'usage is advisory and never fails the doctor');
  assert.equal(result.usage.gate.total, 0);
  assert.ok(
    result.warnings.some((warning) => /no agent has called it yet/.test(warning)),
    `expected the unwired-gate warning, got: ${JSON.stringify(result.warnings)}`,
  );
});

test('an existing but silent trail warns that the installed gate is unused (#4135)', () => {
  const result = checkUsage(
    { now: NOW },
    { readReceipts: () => ({ receipts: [], trailExists: true }), readApprovals: () => [] },
  );

  assert.ok(
    result.warnings.some((warning) => /no gate event was recorded/.test(warning)),
  );
});

test('approval latency and rapid-approve ratio are derived from existing rows (#4135)', () => {
  const result = checkUsage(
    { now: NOW },
    {
      readReceipts: () => ({ receipts: [], trailExists: true }),
      
      readApprovals: () => [
        approvalRow({ createdMsAgo: 60000, decidedMsAgo: 58001 }),
        approvalRow({ createdMsAgo: 120000, decidedMsAgo: 118001 }),
        approvalRow({ createdMsAgo: 10 * 60 * 1000, decidedMsAgo: 8 * 60 * 1000 }),
        approvalRow({ createdMsAgo: 60 * 60 * 1000 }),
      ],
    },
  );

  assert.equal(result.usage.approvals.decided, 3);
  assert.equal(result.usage.approvals.pending, 1);
  assert.equal(result.usage.approvals.rapid, 2);
  assert.ok(Math.abs(result.usage.approvals.rapidRatio - 2 / 3) < 1e-9);
  assert.equal(result.usage.approvals.medianLatencyMs, 1999);
});

test('a mostly-instant decision history raises the fatigue warning with a suggestion (#4135)', () => {
  const result = checkUsage(
    { now: NOW },
    {
      readReceipts: () => ({ receipts: [], trailExists: true }),
     
      readApprovals: () => Array.from({ length: 6 }, (_, index) => approvalRow({
        createdMsAgo: (index + 1) * 60 * 1000,
        decidedMsAgo: (index + 1) * 60 * 1000 - 500,
      })),
    },
  );

  assert.equal(result.usage.approvals.rapid, 6);
  const fatigue = result.warnings.find((warning) => /Approval fatigue/.test(warning));
  assert.ok(fatigue, 'the fatigue warning must fire');
  assert.match(fatigue, /#4102/, 'the warning must point at the policy-template remedy');
});

test('a read-decision history does not raise the fatigue warning (#4135)', () => {
  const result = checkUsage(
    { now: NOW },
    {
      readReceipts: () => ({ receipts: [], trailExists: true }),
     
      readApprovals: () => [
        approvalRow({ createdMsAgo: 60 * 1000, decidedMsAgo: 30000 }),
        approvalRow({ createdMsAgo: 120 * 1000, decidedMsAgo: 60000 }),
      ],
    },
  );

  assert.ok(!result.warnings.some((warning) => /Approval fatigue/.test(warning)));
});

test('rejected and cancelled decisions never count as rapid approvals (#4135)', () => {
  const result = checkUsage(
    { now: NOW },
    {
      readReceipts: () => ({ receipts: [], trailExists: true }),
      readApprovals: () => [
        approvalRow({ createdMsAgo: 60000, decidedMsAgo: 59000, decision: 'approved' }),
        approvalRow({ createdMsAgo: 60000, decidedMsAgo: 59000, decision: 'rejected' }),
        approvalRow({ createdMsAgo: 60000, decidedMsAgo: 59000, decision: 'cancelled' }),
        approvalRow({ createdMsAgo: 60000, decidedMsAgo: 59000, decision: '' }),
      ],
    },
  );

  assert.equal(result.usage.approvals.decided, 4);
  assert.equal(result.usage.approvals.approved, 1);
  assert.equal(result.usage.approvals.rapid, 1);
  assert.equal(result.usage.approvals.rapidRatio, 1);
  assert.ok(
    !result.warnings.some((warning) => /Approval fatigue/.test(warning)),
    'one approved decision is below the minimum sample, so no fatigue warning',
  );
});

test('an unreadable gate trail is a warning, not a failed verdict (#4135)', () => {
  const error = new Error('permission denied');
  error.code = 'EACCES';
  const result = checkUsage(
    { now: NOW },
    { readReceipts: () => { throw error; }, readApprovals: () => [] },
  );

  assert.equal(result.ok, true);
  assert.ok(
    result.warnings.some((warning) => /could not be read \(EACCES\)/.test(warning)),
    `expected the unreadable-trail warning, got: ${JSON.stringify(result.warnings)}`,
  );
});

test('an unreadable approval store is a warning, not a failed verdict (#4135)', () => {
  const error = new Error('no such table: tool_approvals');
  error.code = 'SQLITE_ERROR';
  const result = checkUsage(
    { now: NOW },
    {
      readReceipts: () => ({ receipts: [], trailExists: true }),
      readApprovals: () => { throw error; },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.usage.approvals, null);
  assert.ok(
    result.warnings.some((warning) => /approval rows could not be read/i.test(warning)),
    `expected the unreadable-approvals warning, got: ${JSON.stringify(result.warnings)}`,
  );
});

test('the check makes no network call: it runs with only local readers injected (#4135)', () => {
  // If this check ever grew a network dependency it would need a transport in
  // deps; running it with none and getting a full report is the pin.
  const result = checkUsage(
    { now: NOW },
    {
      readReceipts: () => ({ receipts: [admissionReceipt({ decision: 'allow' })], trailExists: true }),
      readApprovals: () => [],
    },
  );
  assert.equal(result.ok, true);
  assert.match(result.detail, /1 gate events in 7d/);
});