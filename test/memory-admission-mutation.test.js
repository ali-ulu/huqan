'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MEMORY_ADMISSION_POLICY_VERSION,
  normalizeMemoryAdmissionDecision,
  normalizeMemoryAdmissionRequest,
  buildMemoryAdmissionRequest,
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
    // buildMemoryAdmissionReceipt currently projects the top-level riskScore field;\n    // normalizeMemoryAdmissionDecision keeps the score under risk.score, so this remains 0.\n    assert.equal(receipt.riskScore, 0);
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
    [{ ...base, provenanceId: '', riskScore: 20 }, {}, 'review', 'canonical_mutation_requires_provenance'],
    [{ ...base, provenanceId: '', riskScore: 90 }, {}, 'reject', 'missing_provenance_high_risk'],
    [{ ...base, riskScore: 50 }, {}, 'review', 'medium_risk_memory_write'],
    [{ ...base, riskScore: 85 }, {}, 'quarantine', 'high_risk_memory_write'],
    [{ ...base, approvalStatus: 'rejected' }, {}, 'reject', 'approval_rejected'],
    [{ ...base, approvalStatus: 'cancelled' }, {}, 'review', 'approval_cancelled'],
    [{ ...base, approvalStatus: 'expired' }, {}, 'review', 'approval_expired'],
    [{ ...base, approvalStatus: 'pending' }, { approvalRequired: true }, 'review', 'canonical_mutation_requires_approved_approval'],
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

test('decision signal normalization drops malformed signals and preserves valid order', () => {
  const normalized = normalizeMemoryAdmissionDecision({
    decision: 'review',
    signals: [
      null,
      {},
      { decision: 'bogus', reason: 'x' },
      { decision: 'review', reason: '' },
      { decision: ' REVIEW ', reason: ' one ' },
      { decision: 'reject', reason: 'two' },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  assert.deepEqual(normalized.signals, [
    { decision: 'review', reason: 'one' },
    { decision: 'reject', reason: 'two' },
  ]);
});

test('risk score normalization clamps external decision scores and preserves warnings/errors', () => {
  const high = normalizeMemoryAdmissionDecision({
    decision: 'quarantine',
    risk: { level: ' HIGH ', score: 200 },
    warnings: ['', 'warning', null],
    errors: ['bad', { field: 'x', message: 'y' }],
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  assert.deepEqual(high.risk, { level: 'high', score: 100 });
  assert.deepEqual(high.warnings, ['warning']);
  assert.deepEqual(high.errors, [{ message: 'bad' }, { field: 'x', message: 'y' }]);

  const low = normalizeMemoryAdmissionDecision({
    decision: 'allow',
    riskScore: -10,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  assert.deepEqual(low.risk, { level: 'low', score: 0 });
});

test('receipt metadata carries only declared finite confidence, expiry, computed horizon and supported provenance source', () => {
  const normalized = normalizeMemoryAdmissionDecision({
    ...base,
    decision: 'allow',
    request: {
      ...base,
      declaredConfidence: 0.75,
      expiresAt: '2027-01-01T00:00:00.000Z',
      provenanceSource: 'deterministic',
    },
  });
  const receipt = buildMemoryAdmissionReceipt(normalized, {
    receiptId: 'metadata-receipt',
    createdAt: '2026-06-11T12:30:00.000Z',
    metadata: { source: 'manual' },
  });
  assert.deepEqual(receipt.metadata, {
    source: 'manual',
    declaredConfidence: 0.75,
    expiresAt: '2027-01-01T00:00:00.000Z',
    // #2795: the computed reverificationHorizon equals the declared expiresAt
    // here because a declared expiry always wins over the risk-computed one.
    reverificationHorizon: '2027-01-01T00:00:00.000Z',
    provenanceSource: 'deterministic',
  });

  const absent = buildMemoryAdmissionReceipt(normalizeMemoryAdmissionDecision({
    ...base,
    decision: 'allow',
    request: { ...base, declaredConfidence: Number.NaN },
  }), {
    receiptId: 'metadata-absent',
    createdAt: '2026-06-11T12:30:00.000Z',
  });
  assert.deepEqual(absent.metadata, {});
});

test('approval cancellation and expiry become quarantine at high risk', () => {
  for (const approvalStatus of ['cancelled', 'expired']) {
    const result = evaluateMemoryAdmission({
      ...base,
      approvalStatus,
      riskScore: 90,
    }, { approvalRequired: true });
    assert.equal(result.decision.decision, 'quarantine', approvalStatus);
    assert.ok(result.decision.signals.some(signal =>
      signal.decision === 'quarantine' && signal.reason === `approval_${approvalStatus}`
    ));
  }
});

test('quarantine signal vocabulary covers tombstone, delete, supersede and status spellings', () => {
  for (const proposedMemory of [
    { tombstone: true },
    { tombstoned: true },
    { deleted: true },
    { deletedAt: '2026-01-01T00:00:00.000Z' },
    { superseded: true },
    { supersede: true },
    { status: ' deleted ' },
    { status: ' SUPERSEDED ' },
  ]) {
    const result = evaluateMemoryAdmission({ ...base, proposedMemory });
    assert.equal(result.decision.decision, 'quarantine', JSON.stringify(proposedMemory));
    assert.ok(result.decision.signals.some(signal => signal.reason === 'quarantine_signal_detected'));
  }
});


test('request-builder mutation sentinels pin precedence, defaults and deterministic ids', () => {
  const overridden = buildMemoryAdmissionRequest({
    ...base,
    admissionId: '',
    workspaceId: '',
    approvalId: '',
    approvalStatus: '',
    metadata: undefined,
  }, {
    admissionId: 'adm-option',
    workspaceId: 'workspace-option',
    createdAt: '2026-07-01T00:00:00.000Z',
    riskScore: 55,
    approvalRequired: true,
    metadata: { source: 'option' },
  });
  assert.equal(overridden.ok, true);
  assert.equal(overridden.type, 'memory-admission-request');
  assert.equal(overridden.request.admissionId, 'adm-option');
  assert.equal(overridden.request.workspaceId, 'workspace-option');
  assert.equal(overridden.request.createdAt, '2026-07-01T00:00:00.000Z');
  assert.equal(overridden.request.riskScore, 55);
  assert.equal(overridden.request.approvalRequired, true);
  assert.equal(overridden.request.approvalStatus, 'pending');
  assert.deepEqual(overridden.request.metadata, { source: 'option' });

  const crypto = require('node:crypto');
  const generatedInput = {
    ...base,
    admissionId: '',
    approvalId: '',
    approvalStatus: 'not_required',
    createdAt: '2026-07-02T00:00:00.000Z',
  };
  const generated = buildMemoryAdmissionRequest(generatedInput, {
    createdAt: generatedInput.createdAt,
  });
  const expected = 'madm_' + crypto
    .createHash('sha256')
    .update([
      generated.request.workspaceId,
      generated.request.agentId,
      generated.request.actor,
      generated.request.memoryDraftId,
      generated.request.provenanceId,
      generated.request.reason,
      generated.request.createdAt,
    ].join('|'), 'utf8')
    .digest('hex')
    .slice(0, 32);
  assert.equal(generated.ok, true);
  assert.equal(generated.request.admissionId, expected);

  const normalized = normalizeMemoryAdmissionRequest({
    ...base,
    approvalId: '',
    approvalStatus: '',
    riskScore: 101.6,
  }, {
    approvalRequired: false,
  });
  assert.equal(normalized.approvalStatus, 'not_required');
  assert.equal(normalized.riskScore, 100);
});

test('decision projection mutation sentinels pin every fallback surface', () => {
  const requestProjection = {
    ...base,
    workspaceId: 'request-workspace',
    actor: 'request-actor',
    agentId: 'request-agent',
    memoryDraftId: 'request-draft',
    provenanceId: 'request-prov',
    trustPolicyVersion: 'request-policy',
    approvalId: 'request-approval',
    approvalStatus: 'approved',
    createdAt: '2026-08-01T00:00:00.000Z',
    proposedMemory: { content: 'request-content' },
  };
  const normalized = normalizeMemoryAdmissionDecision({
    ok: false,
    decision: 'quarantine',
    reason: ' explicit reason ',
    signals: [
      { decision: 'review', reason: ' review reason ' },
      { decision: 'quarantine', reason: ' quarantine reason ' },
    ],
    risk: { level: ' HIGH ', score: 91 },
    warnings: ['warning'],
    errors: ['plain-error', { field: 'x', message: 'structured' }],
    request: requestProjection,
    receipt: { receiptId: 'nested-receipt', marker: true },
    metadata: { policyVersion: 'policy-x', workspaceId: 'metadata-workspace' },
    admissionId: 'admission-x',
  });

  assert.equal(normalized.ok, false);
  assert.equal(normalized.decision, 'quarantine');
  assert.equal(normalized.allowed, false);
  assert.equal(normalized.canApply, false);
  assert.equal(normalized.canDryRun, true);
  assert.equal(normalized.requiresReview, true);
  assert.equal(normalized.requiredReview, true);
  assert.equal(normalized.quarantined, true);
  assert.equal(normalized.rejected, false);
  assert.equal(normalized.reason, 'explicit reason');
  assert.deepEqual(normalized.signals, [
    { decision: 'review', reason: 'review reason' },
    { decision: 'quarantine', reason: 'quarantine reason' },
  ]);
  assert.deepEqual(normalized.risk, { level: 'high', score: 91 });
  assert.deepEqual(normalized.warnings, ['warning']);
  assert.deepEqual(normalized.errors, [
    { message: 'plain-error' },
    { field: 'x', message: 'structured' },
  ]);
  assert.deepEqual(normalized.request, requestProjection);
  assert.deepEqual(normalized.receipt, { receiptId: 'nested-receipt', marker: true });
  assert.deepEqual(normalized.metadata, {
    policyVersion: 'policy-x',
    workspaceId: 'metadata-workspace',
  });
  assert.equal(normalized.admissionId, 'admission-x');
  assert.equal(normalized.workspaceId, 'request-workspace');
  assert.equal(normalized.actor, 'request-actor');
  assert.equal(normalized.agentId, 'request-agent');
  assert.equal(normalized.memoryDraftId, 'request-draft');
  assert.equal(normalized.provenanceId, 'request-prov');
  assert.equal(normalized.trustPolicyVersion, 'request-policy');
  assert.equal(normalized.approvalId, 'request-approval');
  assert.equal(normalized.approvalStatus, 'approved');
  assert.equal(normalized.receiptId, 'nested-receipt');
  assert.equal(normalized.createdAt, '2026-08-01T00:00:00.000Z');
  assert.deepEqual(normalized.proposedMemory, { content: 'request-content' });
});

test('receipt mutation sentinels pin generated id, reason, signals and full status projection', () => {
  const crypto = require('node:crypto');
  const createdAt = '2026-09-01T00:00:00.000Z';
  const normalized = normalizeMemoryAdmissionDecision({
    ...base,
    decision: 'review',
    reason: 'review-required',
    signals: [{ decision: 'review', reason: 'signal-review' }],
    request: base,
    admissionId: 'madm_001',
    workspaceId: 'workspace-a',
    receiptId: '',
    createdAt,
  });
  const receipt = buildMemoryAdmissionReceipt(normalized, { createdAt });
  const expectedId = 'madm_receipt_' + crypto
    .createHash('sha256')
    .update(['madm_001', 'workspace-a', 'review', createdAt].join('|'), 'utf8')
    .digest('hex')
    .slice(0, 32);
  assert.equal(receipt.receiptId, expectedId);
  assert.equal(receipt.receiptKind, 'memory_review_receipt');
  assert.equal(receipt.receiptType, 'memory-review');
  assert.equal(receipt.decision, 'review');
  assert.equal(receipt.status, 'review');
  assert.equal(receipt.reason, 'review-required');
  assert.deepEqual(receipt.signals, [{ decision: 'review', reason: 'signal-review' }]);
  assert.equal(receipt.canonical, false);
  assert.equal(receipt.reviewed, true);
  assert.equal(receipt.quarantined, false);
  assert.equal(receipt.rejected, false);
  assert.equal(receipt.createdAt, createdAt);

  const invalid = evaluateMemoryAdmission(null, { createdAt });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.type, 'memory-admission-decision');
  assert.equal(invalid.decision, null);
  assert.equal(invalid.receipt, null);
  assert.ok(invalid.errors.length > 0);
});
