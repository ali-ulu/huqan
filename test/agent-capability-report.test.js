'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CAPABILITY_REPORT_VERSION,
  CAPABILITY_PROJECTION_VERSION,
  buildAgentCapabilityReport,
  projectPublicCapabilityReport,
} = require('../lib/agent-capability-report');

function card(overrides = {}) {
  return {
    agentId: 'future-agent-2035',
    agentName: 'future-agent-2035',
    ownerActorId: 'actor:ali',
    workspaceId: 'default',
    capabilities: ['file_read', 'shell'],
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

function impact(overrides = {}) {
  return {
    sessionId: 'session-1',
    priorActions: 3,
    scoredActions: 2,
    unscoredActions: 1,
    recordedScoreTotal: 120,
    maxScore: 80,
    sandboxEscapeAttempts: 0,
    refusedActions: 1,
    retriedRefusedActions: 1,
    status: 'partial',
    reasons: Object.freeze([]),
    ...overrides,
  };
}

test('a card and a summary compile into one capability report', () => {
  const report = buildAgentCapabilityReport({ card: card(), sessionImpact: impact() });
  assert.equal(report.version, CAPABILITY_REPORT_VERSION);
  assert.equal(report.agentRef, 'agent:default:future-agent-2035');
  assert.deepEqual(report.capabilities, ['file_read', 'shell']);
  assert.equal(report.taskScope, null);
  assert.equal(report.identityExpiresAt, '2026-01-02T00:00:00.000Z');
  assert.deepEqual(report.measuredBlastRadius, { total: 120, max: 80, scoredActions: 2, unscoredActions: 1 });
  assert.deepEqual(report.bypassSignals, { refusedActions: 1, retriedRefusedActions: 1, sandboxEscapeAttempts: 0 });
  assert.equal(report.status, 'computed');
  assert.equal(report.enforced, false);
  assert.ok(Object.isFrozen(report));
});

test('a bound card carries its scope into the report', () => {
  const scope = Object.freeze({ taskId: 'task-7', runId: null });
  const report = buildAgentCapabilityReport({ card: card({ taskScope: scope }), sessionImpact: impact() });
  assert.equal(report.taskScope, scope);
});

test('nulls propagate, never read as zero', () => {
  const report = buildAgentCapabilityReport({
    card: card(),
    sessionImpact: impact({
      recordedScoreTotal: null,
      maxScore: null,
      sandboxEscapeAttempts: null,
      refusedActions: null,
      retriedRefusedActions: null,
    }),
  });
  assert.equal(report.measuredBlastRadius.total, null);
  assert.equal(report.measuredBlastRadius.max, null);
  assert.equal(report.bypassSignals.sandboxEscapeAttempts, null);
  assert.equal(report.status, 'computed', 'present-but-null inputs are measured, not missing');
});

test('missing inputs are partial with reasons, and the report is deterministic', () => {
  const empty = buildAgentCapabilityReport({});
  assert.equal(empty.status, 'partial');
  assert.equal(empty.agentRef, null);
  assert.equal(empty.capabilities, null);
  assert.equal(empty.measuredBlastRadius, null);
  assert.ok(empty.reasons.length > 0);

  const first = buildAgentCapabilityReport({ card: card(), sessionImpact: impact() });
  const second = buildAgentCapabilityReport({ card: card(), sessionImpact: impact() });
  assert.deepEqual(first, second);
});

test('the public projection withholds identity, scope and expiry, keeps measurements', () => {
  const scope = Object.freeze({ taskId: 'task-7', runId: 'session-9' });
  const report = buildAgentCapabilityReport({ card: card({ taskScope: scope }), sessionImpact: impact() });
  const projected = projectPublicCapabilityReport(report);
  assert.equal(projected.version, CAPABILITY_PROJECTION_VERSION);
  assert.deepEqual(projected.capabilities, ['file_read', 'shell']);
  assert.deepEqual(projected.measuredBlastRadius, { total: 120, max: 80, scoredActions: 2, unscoredActions: 1 });
  assert.deepEqual(projected.bypassSignals, { refusedActions: 1, retriedRefusedActions: 1, sandboxEscapeAttempts: 0 });
  assert.ok(!('agentRef' in projected));
  assert.ok(!('taskScope' in projected));
  assert.ok(!('identityExpiresAt' in projected));
  const serialized = JSON.stringify(projected);
  assert.ok(!serialized.includes('task-7'));
  assert.ok(!serialized.includes('session-9'));
  assert.ok(!serialized.includes('future-agent-2035'));
  assert.ok(Object.isFrozen(projected));
});

test('foreign versions are refused, degraded content degrades to null', () => {
  assert.throws(() => projectPublicCapabilityReport(null), /capability report/);
  assert.throws(() => projectPublicCapabilityReport({ version: 'v9' }), /version must be/);
  const degraded = projectPublicCapabilityReport({ version: CAPABILITY_REPORT_VERSION, capabilities: 'all' });
  assert.equal(degraded.capabilities, null);
});
