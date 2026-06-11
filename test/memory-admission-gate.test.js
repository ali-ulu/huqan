const assert = require('assert');
const { describe, test } = require('node:test');

const {
  MEMORY_ADMISSION_DECISIONS,
  MEMORY_ADMISSION_POLICY_VERSION,
  MEMORY_ADMISSION_RECEIPT_KINDS,
  buildMemoryAdmissionReceipt,
  buildMemoryAdmissionRequest,
  evaluateMemoryAdmission,
  normalizeMemoryAdmissionDecision,
  validateMemoryAdmissionRequest,
} = require('../lib/memory-admission-gate');

const baseRequest = {
  admissionId: 'madm_001',
  workspaceId: 'workspace-a',
  actor: 'agent-1',
  agentId: 'agent-1',
  memoryDraftId: 'draft-1',
  proposedMemory: {
    memoryId: 'mem-1',
    workspaceId: 'workspace-a',
    content: { title: 'alpha' },
    supersedesMemoryId: 'mem-0',
  },
  provenanceId: 'prov-1',
  trustPolicyVersion: '2026-06',
  approvalId: 'apr_001',
  approvalStatus: 'approved',
  receiptId: '',
  reason: 'write memory',
  riskScore: 20,
  createdAt: '2026-06-11T12:00:00.000Z',
  metadata: { source: 'draft' },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

describe('memory-admission-gate', () => {
  test('stable enums and policy version', () => {
    assert.deepStrictEqual(MEMORY_ADMISSION_DECISIONS, ['allow', 'review', 'reject', 'quarantine']);
    assert.deepStrictEqual(MEMORY_ADMISSION_RECEIPT_KINDS, [
      'memory_admission_receipt',
      'memory_review_receipt',
      'memory_rejection_receipt',
      'memory_quarantine_receipt',
    ]);
    assert.strictEqual(MEMORY_ADMISSION_POLICY_VERSION, 'V3-PR4-v0.1.0');
  });

  test('buildMemoryAdmissionRequest defaults workspace and does not mutate input', () => {
    const source = {
      proposedMemory: clone(baseRequest.proposedMemory),
      reason: 'write memory',
      riskScore: 20,
      provenanceId: 'prov-1',
      trustPolicyVersion: '2026-06',
      actor: 'agent-1',
      agentId: 'agent-1',
      memoryDraftId: 'draft-1',
      createdAt: '2026-06-11T12:00:00.000Z',
    };

    const built = buildMemoryAdmissionRequest(source, { workspaceId: 'workspace-a' });

    assert.ok(built.ok);
    assert.strictEqual(built.request.workspaceId, 'workspace-a');
    assert.strictEqual(built.request.admissionId.startsWith('madm_'), true);
    assert.strictEqual(built.request.approvalStatus, 'not_required');
    assert.deepStrictEqual(source, {
      proposedMemory: clone(baseRequest.proposedMemory),
      reason: 'write memory',
      riskScore: 20,
      provenanceId: 'prov-1',
      trustPolicyVersion: '2026-06',
      actor: 'agent-1',
      agentId: 'agent-1',
      memoryDraftId: 'draft-1',
      createdAt: '2026-06-11T12:00:00.000Z',
    });
  });

  test('validateMemoryAdmissionRequest rejects invalid input cleanly', () => {
    const invalid = validateMemoryAdmissionRequest({
      ...baseRequest,
      proposedMemory: null,
    });

    assert.strictEqual(invalid.ok, false);
    assert.ok(invalid.errors.some((error) => error.field === 'proposedMemory'));
  });

  test('low-risk request with provenance can allow', () => {
    const result = evaluateMemoryAdmission(baseRequest);

    assert.ok(result.ok);
    assert.strictEqual(result.decision.decision, 'allow');
    assert.strictEqual(result.decision.allowed, true);
    assert.strictEqual(result.decision.requiresReview, false);
    assert.strictEqual(result.receipt.receiptKind, 'memory_admission_receipt');
    assert.strictEqual(result.receipt.canonical, true);
    assert.strictEqual(result.receipt.workspaceId, 'workspace-a');
    assert.strictEqual(result.receipt.actor, 'agent-1');
    assert.strictEqual(result.receipt.provenanceId, 'prov-1');
  });

  test('missing provenance yields review and approval-required missing yields review', () => {
    const noProvenance = evaluateMemoryAdmission({
      ...baseRequest,
      provenanceId: '',
      riskScore: 30,
    });
    assert.ok(noProvenance.ok);
    assert.strictEqual(noProvenance.decision.decision, 'review');
    assert.strictEqual(noProvenance.receipt.receiptKind, 'memory_review_receipt');

    const missingApproval = evaluateMemoryAdmission({
      ...baseRequest,
      approvalId: '',
      approvalStatus: '',
      provenanceId: 'prov-1',
      riskScore: 35,
    }, { approvalRequired: true });
    assert.ok(missingApproval.ok);
    assert.strictEqual(missingApproval.decision.decision, 'review');
    assert.strictEqual(missingApproval.decision.approvalStatus, 'pending');
  });

  test('rejected approval returns reject and high risk returns quarantine', () => {
    const rejected = evaluateMemoryAdmission({
      ...baseRequest,
      approvalStatus: 'rejected',
    });
    assert.ok(rejected.ok);
    assert.strictEqual(rejected.decision.decision, 'reject');
    assert.strictEqual(rejected.receipt.receiptKind, 'memory_rejection_receipt');
    assert.strictEqual(rejected.receipt.rejected, true);

    const quarantine = evaluateMemoryAdmission({
      ...baseRequest,
      approvalStatus: 'approved',
      riskScore: 95,
    });
    assert.ok(quarantine.ok);
    assert.strictEqual(quarantine.decision.decision, 'quarantine');
    assert.strictEqual(quarantine.receipt.receiptKind, 'memory_quarantine_receipt');
    assert.strictEqual(quarantine.receipt.quarantined, true);
  });

  test('receipt builders and normalizer are JSON-safe and deterministic', () => {
    const normalized = normalizeMemoryAdmissionDecision({
      ok: true,
      decision: 'allow',
      reason: 'low risk',
      risk: { level: 'low', score: 10 },
      admissionId: 'madm_001',
      workspaceId: 'workspace-a',
      actor: 'agent-1',
      agentId: 'agent-1',
      memoryDraftId: 'draft-1',
      provenanceId: 'prov-1',
      trustPolicyVersion: '2026-06',
      approvalId: 'apr_001',
      approvalStatus: 'approved',
      createdAt: '2026-06-11T12:00:00.000Z',
      proposedMemory: clone(baseRequest.proposedMemory),
    });

    const receipt = buildMemoryAdmissionReceipt(normalized, {
      createdAt: '2026-06-11T12:15:00.000Z',
      metadata: { source: 'manual-review' },
    });

    assert.strictEqual(JSON.stringify(receipt).includes('undefined'), false);
    assert.strictEqual(receipt.receiptKind, 'memory_admission_receipt');
    assert.strictEqual(receipt.workspaceId, 'workspace-a');
    assert.strictEqual(receipt.actor, 'agent-1');
    assert.strictEqual(normalized.allowed, true);
    assert.strictEqual(normalized.metadata.workspaceId, 'workspace-a');
    assert.strictEqual(normalized.metadata.policyVersion, MEMORY_ADMISSION_POLICY_VERSION);
  });
});
