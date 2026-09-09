const assert = require('assert');
const { describe, test } = require('node:test');

const {
  buildMemoryAdmissionRequest,
  evaluateMemoryAdmission,
} = require('../lib/memory-admission-gate');
const { evaluateMemoryRecall } = require('../lib/memory-recall-gate');

const CREATED_AT = '2026-03-14T09:22:00.000Z';

function admissionRequest(overrides = {}) {
  return {
    admissionId: 'madm_expiry',
    workspaceId: 'workspace-a',
    actor: 'agent-1',
    agentId: 'agent-1',
    memoryDraftId: 'draft-1',
    proposedMemory: { memoryId: 'mem-1', workspaceId: 'workspace-a', content: { title: 'alpha' } },
    provenanceId: 'prov-1',
    trustPolicyVersion: '0.8.0',
    approvalStatus: 'not_required',
    reason: 'unit-test',
    createdAt: CREATED_AT,
    riskScore: 0,
    ...overrides,
  };
}

describe('admission gate: does it expire?', () => {
  test('a write with no expiry is unaffected', () => {
    const result = evaluateMemoryAdmission(admissionRequest());
    assert.strictEqual(result.decision.decision, 'allow');
    assert.strictEqual(result.decision.receipt.metadata.expiresAt, undefined);
  });

  test('a future expiry is carried onto the receipt', () => {
    const result = evaluateMemoryAdmission(admissionRequest({ expiresAt: '2027-01-01T00:00:00.000Z' }));
    assert.strictEqual(result.decision.decision, 'allow');
    assert.strictEqual(result.decision.receipt.metadata.expiresAt, '2027-01-01T00:00:00.000Z');
  });

  test('a write that is already expired is rejected', () => {
    const result = evaluateMemoryAdmission(admissionRequest({ expiresAt: '2026-01-01T00:00:00.000Z' }));
    assert.strictEqual(result.decision.decision, 'reject');
    assert.strictEqual(result.decision.reason, 'expired_before_admission');
  });

  test('an expiry equal to createdAt is rejected: it never had a valid life', () => {
    const result = evaluateMemoryAdmission(admissionRequest({ expiresAt: CREATED_AT }));
    assert.strictEqual(result.decision.decision, 'reject');
    assert.strictEqual(result.decision.reason, 'expired_before_admission');
  });

  test('an unparseable expiry fails validation rather than being ignored', () => {
    const built = buildMemoryAdmissionRequest(admissionRequest({ expiresAt: 'yesterday' }));
    assert.strictEqual(built.ok, false);
    assert.ok(built.errors.some((e) => e.field === 'expiresAt'));
  });

  test('an already-expired write is rejected even when it is otherwise perfect', () => {
    const result = evaluateMemoryAdmission(admissionRequest({
      expiresAt: '2026-01-01T00:00:00.000Z',
      approvalStatus: 'approved',
      riskScore: 0,
    }));
    assert.strictEqual(result.decision.allowed, false);
  });
});

describe('recall gate: an expired record is not authoritative', () => {
  const OBSERVED = '2026-06-01T00:00:00.000Z';

  function record(overrides = {}) {
    return {
      memoryId: 'mem-1',
      workspaceId: 'workspace-a',
      status: 'active',
      trustPolicyVersion: '0.8.0',
      content: { title: 'alpha' },
      provenance: { provenanceId: 'prov-1', confidence: 0.9 },
      ...overrides,
    };
  }

  function evaluate(records) {
    return evaluateMemoryRecall({
      workspaceId: 'workspace-a',
      records,
      currentTrustPolicyVersion: '0.8.0',
      observedAt: OBSERVED,
    });
  }

  test('a record whose expiry has passed is degraded, not admitted', () => {
    const result = evaluate([record({ expiresAt: '2026-05-01T00:00:00.000Z' })]);
    assert.strictEqual(result.decisions[0].decision, 'degrade');
    assert.strictEqual(result.decisions[0].reason, 'expired_record');
  });

  test('degrade, not withhold: an expired record may still be true and stays explainable', () => {
    const result = evaluate([record({ expiresAt: '2026-05-01T00:00:00.000Z' })]);
    assert.strictEqual(result.degraded.length, 1);
    assert.strictEqual(result.withheld.length, 0);
    assert.strictEqual(result.ledgerEvents[0].eventType, 'memory_recall_degraded');
  });

  test('a record that has not expired yet is admitted', () => {
    const result = evaluate([record({ expiresAt: '2027-01-01T00:00:00.000Z' })]);
    assert.strictEqual(result.decisions[0].decision, 'admit');
  });

  test('a record with no expiry is unaffected', () => {
    const result = evaluate([record()]);
    assert.strictEqual(result.decisions[0].decision, 'admit');
  });

  test('an unparseable expiry is degraded rather than silently trusted', () => {
    const result = evaluate([record({ expiresAt: 'whenever' })]);
    assert.strictEqual(result.decisions[0].decision, 'degrade');
    assert.strictEqual(result.decisions[0].reason, 'unparseable_expiry');
  });

  test('expiry outranks staleness when both fire, and both are reported', () => {
    const result = evaluate([record({ expiresAt: '2026-05-01T00:00:00.000Z', trustPolicyVersion: '0.7.0' })]);
    const reasons = result.decisions[0].signals.map((s) => s.reason);
    assert.ok(reasons.includes('expired_record'));
    assert.ok(reasons.includes('stale_trust_policy'));
  });
});
