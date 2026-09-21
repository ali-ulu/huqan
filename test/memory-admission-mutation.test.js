'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MEMORY_ADMISSION_POLICY_VERSION,
  normalizeMemoryAdmissionDecision,
  buildMemoryAdmissionReceipt,
  validateMemoryAdmissionRequest,
  evaluateMemoryAdmission,
} = require('../lib/memory-admission-gate');

const base = {
  admissionId: 'madm_001',
  workspaceId: 'workspace-a',
  actor: 'agent-1',
  agentId: 'agent-1',
  memoryDraftId: 'draft-1',
  proposedMemory: { content: { title: 'alpha' } },
  provenanceId: 'prov-1',
  trustPolicyVersion: '2026-06',
  approvalId: 'apr_001',
  approvalStatus: 'approved',
  reason: 'write memory',
  riskScore: 20,
  createdAt: '2026-06-11T12:00:00.000Z',
};

test('decision normalizer pins fail-closed defaults and each decision boolean', () => {
  const fallback = normalizeMemoryAdmissionDecision({});
  assert.equal(fallback.decision, 'review');
  assert.equal(fallback.allowed, false);
  assert.equal(fallback.canApply, false);
  assert.equal(fallback.canDryRun, true);
  assert.equal(fallback.requiresReview, true);
  assert.equal(fallback.reason, 'Memory admission requires review');
  assert.equal(fallback.risk.level, 'medium');
  assert.equal(fallback.risk.score, 0);
  assert.equal(fallback.metadata.policyVersion, MEMORY_ADMISSION_POLICY_VERSION);
  assert.equal(fallback.metadata.workspaceId, 'default');

  const expected = {
    allow: [true, true, true, false, false, false],
    review: [false, false, true, true, false, false],
    quarantine: [false, false, true, true, true, false],
    reject: [false, false, false, true, false, true],
  };
  for (const [decision, values] of Object.entries(expected)) {
    const normalized = normalizeMemoryAdmissionDecision({
      decision,
      risk: { score: 10 },
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    assert.deepEqual([
      normalized.allowed,
      normalized.canApply,
      normalized.canDryRun,
      normalized.requiresReview,
      normalized.quarantined,
      normalized.rejected,
    ], values, decision);
  }
});

test('receipt builder pins kind, status and decision booleans for every decision', () => {
  const expected = {
    allow: ['memory_admission_receipt', 'memory-admission', 'admitted', true, false, false, false],
    review: ['memory_review_receipt', 'memory-review', 'review', false, true, false, false],
    quarantine: ['memory_quarantine_receipt', 'memory-quarantine', 'quarantined', false, false, true, false],
    reject: ['memory_rejection_receipt', 'memory-rejection', 'rejected', false, false, false, true],
  };
  for (const [decision, values] of Object.entries(expected)) {
    const normalized = normalizeMemoryAdmissionDecision({
      ...base,
      decision,
      risk: { score: 25 },
      request: base,
    });
    const receipt = buildMemoryAdmissionReceipt(normalized, {
      receiptId: `receipt-${decision}`,
      createdAt: '2026-06-11T12:30:00.000Z',
      metadata: { source: 'test' },
    });
    assert.deepEqual([
      receipt.receiptKind,
      receipt.receiptType,
      receipt.status,
      receipt.canonical,
      receipt.reviewed,
      receipt.quarantined,
      receipt.rejected,
    ], values, decision);
    assert.equal(receipt.receiptId, `receipt-${decision}`);
    assert.equal(receipt.admissionId, 'madm_001');
    assert.equal(receipt.workspaceId, 'workspace-a');
    assert.equal(receipt.actor, 'agent-1');
    assert.equal(receipt.agentId, 'agent-1');
    assert.equal(receipt.memoryDraftId, 'draft-1');
    assert.equal(receipt.provenanceId, 'prov-1');
    assert.equal(receipt.trustPolicyVersion, '2026-06');
    assert.equal(receipt.approvalId, 'apr_001');
    assert.equal(receipt.approvalStatus, 'approved');
    assert.equal(receipt.riskScore, 25);
    assert.equal(receipt.createdAt, '2026-06-11T12:30:00.000Z');
  }
});

test('validation rejects timestamp, provenance source and proposed-memory boundary failures', () => {
  assert.equal(validateMemoryAdmissionRequest(base).ok, true);

  const badMemory = validateMemoryAdmissionRequest({ ...base, proposedMemory: null });
  assert.ok(badMemory.errors.some(error => error.field === 'proposedMemory' && error.message === 'proposedMemory is required'));

  const badCreated = validateMemoryAdmissionRequest({ ...base, createdAt: 'not-a-date' });
  assert.ok(badCreated.errors.some(error => error.field === 'createdAt' && error.message === 'createdAt must be a parseable timestamp'));

  const badExpiry = validateMemoryAdmissionRequest({ ...base, expiresAt: 'not-a-date' });
  assert.ok(badExpiry.errors.some(error => error.field === 'expiresAt' && error.message === 'expiresAt must be a parseable timestamp'));

  const badSource = validateMemoryAdmissionRequest({ ...base, provenanceSource: 'unknown' });
  assert.ok(badSource.errors.some(error => error.field === 'provenanceSource'));

  for (const source of ['deterministic', 'permitted_fallback']) {
    assert.equal(validateMemoryAdmissionRequest({ ...base, provenanceSource: source }).ok, true, source);
  }
});

test('admission decision matrix preserves strictest safety signal', () => {
  const cases = [
    [{ ...base, riskScore: 20 }, {}, 'allow', 'provenance_present_low_risk'],
    [{ ...base, provenanceId: '', riskScore: 20 }, {}, 'review', 'missing_provenance'],
    [{ ...base, provenanceId: '', riskScore: 90 }, {}, 'reject', 'missing_provenance_high_risk'],
    [{ ...base, riskScore: 50 }, {}, 'review', 'medium_risk_memory_write'],
    [{ ...base, riskScore: 85 }, {}, 'quarantine', 'high_risk_memory_write'],
    [{ ...base, approvalStatus: 'rejected' }, {}, 'reject', 'approval_rejected'],
    [{ ...base, approvalStatus: 'cancelled' }, {}, 'review', 'approval_cancelled'],
    [{ ...base, approvalStatus: 'expired' }, {}, 'review', 'approval_expired'],
    [{ ...base, approvalStatus: 'pending' }, { approvalRequired: true }, 'review', 'approval_required'],
    [{ ...base, proposedMemory: { content: 'x', tombstone: true } }, {}, 'quarantine', 'quarantine_signal_detected'],
    [{ ...base, expiresAt: '2026-06-11T11:59:59.000Z' }, {}, 'reject', 'expired_before_admission'],
    [{ ...base, expiresAt: '2026-06-11T12:00:00.000Z' }, {}, 'reject', 'expired_before_admission'],
  ];

  for (const [input, options, decision, reason] of cases) {
    const result = evaluateMemoryAdmission(input, options);
    assert.equal(result.ok, true, reason);
    assert.equal(result.decision.decision, decision, reason);
    assert.equal(result.decision.reason, reason, reason);
    assert.equal(result.receipt.decision, decision, reason);
  }
});

test('approval-required canonical writes expose both independent review reasons', () => {
  const result = evaluateMemoryAdmission({
    ...base,
    provenanceId: '',
    approvalId: '',
    approvalStatus: '',
    riskScore: 10,
  }, { approvalRequired: true });
  const reasons = result.decision.signals.map(signal => signal.reason);
  assert.ok(reasons.includes('missing_provenance'));
  assert.ok(reasons.includes('approval_required'));
  assert.ok(reasons.includes('canonical_mutation_requires_provenance'));
  assert.ok(reasons.includes('canonical_mutation_requires_approved_approval'));
});
