'use strict';

/**
 * Canary state machine + Capability Trust extension tests (design comment
 * on #2397, R3 Phase 9). Covers acceptance tests 2-9 from that comment (1
 * lives in test/experience-optimization-hypothesis.test.js).
 *
 * Hermetic: no I/O, no storage, no timers.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  CANARY_STATUS,
  MIN_CANARY_SAMPLE_SIZE,
  evaluateCanaryTrial,
  shouldRouteToCandidate,
  createPromotionAdmissionRegistry,
} = require('../lib/experience/canary');

const {
  TRUST_STATES,
  MIN_TRUSTED_EXECUTIONS,
  createCapabilityTrustRegistry,
} = require('../lib/experience/capability-trust');

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const MIN = 60 * 1000;
// #3552: authority identities are verified through the host's resolver.
const VERIFIED = (reference) => ({ ok: true, principal: { id: reference } });

function run(i, { negative = false, executionCost = 1, verificationCost = 1, canaryOverheadCost = 0 } = {}) {
  return {
    occurredAt: T0 + i * MIN,
    declared: { endpoint: 'replace_text', lang: 'en' },
    learningEligibility: negative ? 'negative_example' : 'positive_procedure',
    executionCost,
    verificationCost,
    canaryOverheadCost,
  };
}

function makeRuns(count, opts) {
  return Array.from({ length: count }, (_, i) => run(i, opts));
}

describe('Canary: acceptance test 2 — totalCost includes verification cost', () => {
  it('a candidate faster to execute but more expensive to verify fails canary if the total is worse', () => {
    // Candidate: cheap execution (1), expensive verification (20) -> 21/run.
    const candidateRuns = makeRuns(MIN_CANARY_SAMPLE_SIZE, { executionCost: 1, verificationCost: 20 });
    // Baseline: slower execution (10) but near-free verification (1) -> 11/run.
    const baselineRuns = makeRuns(MIN_CANARY_SAMPLE_SIZE, { executionCost: 10, verificationCost: 1 });

    const result = evaluateCanaryTrial({ candidateRuns, baselineWindowRuns: baselineRuns, startAt: T0 });
    assert.equal(result.ok, true);
    assert.equal(result.status, CANARY_STATUS.FAILED);
    assert.ok(result.candidateMetrics.totalCost > result.baselineMetrics.totalCost);
  });

  it('passes when the candidate totalCost (execution + verification) genuinely clears baseline', () => {
    const candidateRuns = makeRuns(MIN_CANARY_SAMPLE_SIZE, { executionCost: 1, verificationCost: 1 });
    const baselineRuns = makeRuns(MIN_CANARY_SAMPLE_SIZE, { executionCost: 10, verificationCost: 10 });
    const result = evaluateCanaryTrial({ candidateRuns, baselineWindowRuns: baselineRuns, startAt: T0 });
    assert.equal(result.status, CANARY_STATUS.PASSED);
  });
});

describe('Canary: acceptance test 3 — non-overlapping request shapes refuse the comparison', () => {
  it('refuses (ok: false) rather than silently scoring a comparison across disjoint request shapes', () => {
    const candidateRuns = Array.from({ length: MIN_CANARY_SAMPLE_SIZE }, (_, i) => ({
      ...run(i),
      declared: { endpoint: 'summarize_text', lang: 'fr' },
    }));
    const baselineRuns = makeRuns(MIN_CANARY_SAMPLE_SIZE); // { endpoint: 'replace_text', lang: 'en' }

    const result = evaluateCanaryTrial({ candidateRuns, baselineWindowRuns: baselineRuns, startAt: T0 });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'comparison_refused_no_shape_overlap');
  });

  it('scores normally once at least one pair of requests overlaps in shape', () => {
    const candidateRuns = makeRuns(MIN_CANARY_SAMPLE_SIZE, { executionCost: 1, verificationCost: 1 });
    // One baseline run overlaps in shape with the candidate's; the rest do not.
    const baselineRuns = [
      run(0, { executionCost: 10, verificationCost: 10 }),
      ...Array.from({ length: MIN_CANARY_SAMPLE_SIZE - 1 }, (_, i) => ({
        ...run(i + 1, { executionCost: 10, verificationCost: 10 }),
        declared: { endpoint: 'other_capability' },
      })),
    ];
    const result = evaluateCanaryTrial({ candidateRuns, baselineWindowRuns: baselineRuns, startAt: T0 });
    assert.equal(result.ok, true);
    assert.notEqual(result.status, undefined);
  });
});

describe('Canary: acceptance test 4 — a failing canary never routes outside its capped sample', () => {
  it('routes on the sampled Nth request while status is in_trial', () => {
    assert.equal(shouldRouteToCandidate({ status: CANARY_STATUS.IN_TRIAL, requestSequenceNumber: 5, sampleEveryNth: 5 }), true);
    assert.equal(shouldRouteToCandidate({ status: CANARY_STATUS.IN_TRIAL, requestSequenceNumber: 4, sampleEveryNth: 5 }), false);
  });

  it('never routes once the canary has failed, even on a request that would otherwise be sampled', () => {
    for (let seq = 1; seq <= 50; seq += 1) {
      assert.equal(
        shouldRouteToCandidate({ status: CANARY_STATUS.FAILED, requestSequenceNumber: seq, sampleEveryNth: 5 }),
        false,
        `sequence ${seq} must never route to a failed canary`,
      );
    }
  });

  it('never routes once the cap has been reached, even while nominally still in_trial', () => {
    for (let seq = 1; seq <= 50; seq += 1) {
      assert.equal(
        shouldRouteToCandidate({
          status: CANARY_STATUS.IN_TRIAL, requestSequenceNumber: seq, sampleEveryNth: 5, capReached: true,
        }),
        false,
      );
    }
  });

  it('a canary that fails at trial evaluation reports FAILED and its own routing function refuses production traffic', () => {
    const candidateRuns = makeRuns(MIN_CANARY_SAMPLE_SIZE, { executionCost: 100, verificationCost: 100 });
    const baselineRuns = makeRuns(MIN_CANARY_SAMPLE_SIZE, { executionCost: 1, verificationCost: 1 });
    const trial = evaluateCanaryTrial({ candidateRuns, baselineWindowRuns: baselineRuns, startAt: T0 });
    assert.equal(trial.status, CANARY_STATUS.FAILED);
    assert.equal(shouldRouteToCandidate({ status: trial.status, requestSequenceNumber: 5, sampleEveryNth: 5 }), false);
  });
});

describe('Canary: acceptance test 5 — canary pass alone does not promote without admission', () => {
  it('refuses promotion when canary passed but no explicit approval and no toggle exist', () => {
    const registry = createCapabilityTrustRegistry();
    registry.createCapability({ workspaceId: 'ws-a', capabilityId: 'cap-5', boundProcedureVersion: 'v1' });
    const admissionRegistry = createPromotionAdmissionRegistry({ resolvePrincipal: VERIFIED });
    const admission = admissionRegistry.resolveAdmission({
      workspaceId: 'ws-a', capabilityId: 'cap-5', promotionId: 'promo-1',
    });
    assert.equal(admission.admitted, false);

    const res = registry.promoteCanaryCandidate({
      workspaceId: 'ws-a', capabilityId: 'cap-5', candidateProcedureVersion: 'v2',
      canaryResult: { status: CANARY_STATUS.PASSED, reason: 'cleared_baseline' },
      admission,
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'promotion_not_admitted');
    assert.equal(registry.get('ws-a', 'cap-5').boundProcedureVersion, 'v1');
  });

  it('refuses promotion when admitted but canary did not pass', () => {
    const registry = createCapabilityTrustRegistry();
    registry.createCapability({ workspaceId: 'ws-a', capabilityId: 'cap-5b', boundProcedureVersion: 'v1' });
    const admissionRegistry = createPromotionAdmissionRegistry({ resolvePrincipal: VERIFIED });
    admissionRegistry.recordExplicitApproval({
      workspaceId: 'ws-a', capabilityId: 'cap-5b', promotionId: 'promo-2', approverId: 'human-1',
    });
    const admission = admissionRegistry.resolveAdmission({
      workspaceId: 'ws-a', capabilityId: 'cap-5b', promotionId: 'promo-2',
    });
    assert.equal(admission.admitted, true);

    const res = registry.promoteCanaryCandidate({
      workspaceId: 'ws-a', capabilityId: 'cap-5b', candidateProcedureVersion: 'v2',
      canaryResult: { status: CANARY_STATUS.FAILED, reason: 'did_not_clear_baseline' },
      admission,
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'canary_not_passed');
  });

  it('promotes only when BOTH canary passed AND admission (explicit approval) exist', () => {
    const registry = createCapabilityTrustRegistry();
    registry.createCapability({ workspaceId: 'ws-a', capabilityId: 'cap-5c', boundProcedureVersion: 'v1' });
    const admissionRegistry = createPromotionAdmissionRegistry({ resolvePrincipal: VERIFIED });
    admissionRegistry.recordExplicitApproval({
      workspaceId: 'ws-a', capabilityId: 'cap-5c', promotionId: 'promo-3', approverId: 'human-1',
    });
    const admission = admissionRegistry.resolveAdmission({
      workspaceId: 'ws-a', capabilityId: 'cap-5c', promotionId: 'promo-3',
    });
    const res = registry.promoteCanaryCandidate({
      workspaceId: 'ws-a', capabilityId: 'cap-5c', candidateProcedureVersion: 'v2',
      canaryResult: { status: CANARY_STATUS.PASSED, reason: 'cleared_baseline' },
      admission,
    });
    assert.equal(res.ok, true);
    assert.equal(res.entry.boundProcedureVersion, 'v2');
  });

  it('a standing, receipted auto-promote toggle also produces an admission record — and a fresh receipt per promotion', () => {
    const admissionRegistry = createPromotionAdmissionRegistry({ resolvePrincipal: VERIFIED });
    const toggle = admissionRegistry.setAutoPromoteToggle({
      workspaceId: 'ws-a', capabilityId: 'cap-5d', adminId: 'admin-1', enabled: true,
    });
    assert.equal(toggle.ok, true);
    assert.ok(toggle.receipt.receiptId);

    const admission1 = admissionRegistry.resolveAdmission({ workspaceId: 'ws-a', capabilityId: 'cap-5d', promotionId: 'promo-a' });
    const admission2 = admissionRegistry.resolveAdmission({ workspaceId: 'ws-a', capabilityId: 'cap-5d', promotionId: 'promo-b' });
    assert.equal(admission1.admitted, true);
    assert.equal(admission1.mode, 'auto_promote_toggle');
    assert.equal(admission2.admitted, true);
    // Each promotion event gets its OWN receipt -- "auto" changes who
    // approves, never whether an approval record exists.
    assert.notEqual(admission1.receipt.receiptId, admission2.receipt.receiptId);
  });
});

describe('Canary: acceptance test 6 — promotion lands in probationary, must re-earn trust', () => {
  it('a canary-passed, admitted promotion is an ordinary rebind: probationary, not trusted', () => {
    const registry = createCapabilityTrustRegistry();
    // Get v1 to trusted first, so we can see the rebind's forced demotion.
    for (let i = 0; i < MIN_TRUSTED_EXECUTIONS; i += 1) {
      registry.recordRun({
        workspaceId: 'ws-a', capabilityId: 'cap-6', procedureVersion: 'v1',
        eventId: `e${i}`, runId: `r${i}`, learningEligibility: 'positive_procedure', occurredAt: T0 + i * MIN,
      });
    }
    assert.equal(registry.get('ws-a', 'cap-6').trustState, TRUST_STATES.TRUSTED);

    const admissionRegistry = createPromotionAdmissionRegistry({ resolvePrincipal: VERIFIED });
    admissionRegistry.recordExplicitApproval({
      workspaceId: 'ws-a', capabilityId: 'cap-6', promotionId: 'promo-6', approverId: 'human-1',
    });
    const admission = admissionRegistry.resolveAdmission({ workspaceId: 'ws-a', capabilityId: 'cap-6', promotionId: 'promo-6' });

    const res = registry.promoteCanaryCandidate({
      workspaceId: 'ws-a', capabilityId: 'cap-6', candidateProcedureVersion: 'v2',
      canaryResult: { status: CANARY_STATUS.PASSED, reason: 'cleared_baseline' },
      admission,
    });
    assert.equal(res.ok, true);
    assert.equal(res.entry.trustState, TRUST_STATES.PROBATIONARY);
    assert.equal(res.entry.boundProcedureVersion, 'v2');

    // Must re-earn trust under the UNMODIFIED ordinary rules -- zero
    // shortcut from having cleared canary.
    for (let i = 0; i < MIN_TRUSTED_EXECUTIONS - 1; i += 1) {
      registry.recordRun({
        workspaceId: 'ws-a', capabilityId: 'cap-6', procedureVersion: 'v2',
        eventId: `v2e${i}`, runId: `v2r${i}`, learningEligibility: 'positive_procedure',
        occurredAt: T0 + (1000 + i) * MIN,
      });
    }
    assert.notEqual(registry.get('ws-a', 'cap-6').trustState, TRUST_STATES.TRUSTED);
    const finalRes = registry.recordRun({
      workspaceId: 'ws-a', capabilityId: 'cap-6', procedureVersion: 'v2',
      eventId: 'v2-final', runId: 'v2-final', learningEligibility: 'positive_procedure',
      occurredAt: T0 + 2000 * MIN,
    });
    assert.equal(finalRes.entry.trustState, TRUST_STATES.TRUSTED);
  });
});

describe('Canary: acceptance test 7 — rollback without destroying newer evidence', () => {
  it('restores the prior boundProcedureVersion; both versions remain independently queryable', () => {
    const registry = createCapabilityTrustRegistry();
    for (let i = 0; i < MIN_TRUSTED_EXECUTIONS; i += 1) {
      registry.recordRun({
        workspaceId: 'ws-a', capabilityId: 'cap-7', procedureVersion: 'v1',
        eventId: `v1e${i}`, runId: `v1r${i}`, learningEligibility: 'positive_procedure', occurredAt: T0 + i * MIN,
      });
    }
    const admissionRegistry = createPromotionAdmissionRegistry({ resolvePrincipal: VERIFIED });
    admissionRegistry.recordExplicitApproval({
      workspaceId: 'ws-a', capabilityId: 'cap-7', promotionId: 'promo-7', approverId: 'human-1',
    });
    const admission = admissionRegistry.resolveAdmission({ workspaceId: 'ws-a', capabilityId: 'cap-7', promotionId: 'promo-7' });
    registry.promoteCanaryCandidate({
      workspaceId: 'ws-a', capabilityId: 'cap-7', candidateProcedureVersion: 'v2',
      canaryResult: { status: CANARY_STATUS.PASSED, reason: 'cleared_baseline' }, admission,
    });
    for (let i = 0; i < 5; i += 1) {
      registry.recordRun({
        workspaceId: 'ws-a', capabilityId: 'cap-7', procedureVersion: 'v2',
        eventId: `v2e${i}`, runId: `v2r${i}`, learningEligibility: 'negative_example',
        occurredAt: T0 + (1000 + i) * MIN,
      });
    }
    assert.equal(registry.get('ws-a', 'cap-7').boundProcedureVersion, 'v2');

    const rollbackAdmissionRegistry = createPromotionAdmissionRegistry({ resolvePrincipal: VERIFIED });
    rollbackAdmissionRegistry.recordExplicitApproval({
      workspaceId: 'ws-a', capabilityId: 'cap-7', promotionId: 'rollback-1', approverId: 'human-2',
    });
    const rollbackAdmission = rollbackAdmissionRegistry.resolveAdmission({
      workspaceId: 'ws-a', capabilityId: 'cap-7', promotionId: 'rollback-1',
    });

    // Unknown target refuses rather than assumes.
    const badRollback = registry.rollbackToPriorVersion({
      workspaceId: 'ws-a', capabilityId: 'cap-7', targetProcedureVersion: 'v99', admission: rollbackAdmission,
    });
    assert.equal(badRollback.ok, false);
    assert.equal(badRollback.code, 'unknown_prior_version');

    const rollback = registry.rollbackToPriorVersion({
      workspaceId: 'ws-a', capabilityId: 'cap-7', targetProcedureVersion: 'v1', admission: rollbackAdmission,
      reason: 'operator_initiated',
    });
    assert.equal(rollback.ok, true);
    assert.equal(rollback.entry.boundProcedureVersion, 'v1');
    assert.equal(rollback.entry.trustState, TRUST_STATES.PROBATIONARY);

    // Both versions' evidence remain independently queryable, unmodified.
    const v1Evidence = registry.getEvidenceForVersion('ws-a', 'cap-7', 'v1');
    const v2Evidence = registry.getEvidenceForVersion('ws-a', 'cap-7', 'v2');
    assert.equal(v1Evidence.totalCount, MIN_TRUSTED_EXECUTIONS);
    assert.equal(v2Evidence.totalCount, 5);
    assert.equal(v2Evidence.negativeCount, 5);
  });
});

describe('Canary: acceptance test 8 — drift proposes a rollback receipt, never reverts alone', () => {
  it('fires drift on the currently-promoted version and proposes a receipt without touching boundProcedureVersion', () => {
    const registry = createCapabilityTrustRegistry();
    registry.createCapability({ workspaceId: 'ws-a', capabilityId: 'cap-8', boundProcedureVersion: 'v2' });

    const currentEvents = Array.from({ length: MIN_TRUSTED_EXECUTIONS }, (_, i) => ({
      occurredAt: T0 + i * MIN,
      learningEligibility: i < 8 ? 'negative_example' : 'positive_procedure', // high negative rate
      executionCost: 1,
      verificationCost: 1,
    }));
    const promotionBaseline = { rateAtLastPromotion: 0.0, totalCostAtLastPromotion: 1000 };

    const drift = registry.proposeDriftRollback({
      workspaceId: 'ws-a', capabilityId: 'cap-8', currentEvents, promotionBaseline,
      priorProcedureVersion: 'v1', now: T0 + MIN_TRUSTED_EXECUTIONS * MIN,
    });
    assert.equal(drift.ok, true);
    assert.equal(drift.driftDetected, true);
    assert.ok(drift.proposedRollbackReceipt);
    assert.equal(drift.proposedRollbackReceipt.applied, false);
    assert.equal(drift.proposedRollbackReceipt.currentProcedureVersion, 'v2');

    // Never reverts on its own: boundProcedureVersion is untouched.
    assert.equal(registry.get('ws-a', 'cap-8').boundProcedureVersion, 'v2');
  });

  it('does not detect drift (and proposes nothing) when the currently-promoted version is healthy', () => {
    const registry = createCapabilityTrustRegistry();
    registry.createCapability({ workspaceId: 'ws-a', capabilityId: 'cap-8b', boundProcedureVersion: 'v2' });
    const currentEvents = Array.from({ length: MIN_TRUSTED_EXECUTIONS }, (_, i) => ({
      occurredAt: T0 + i * MIN, learningEligibility: 'positive_procedure', executionCost: 1, verificationCost: 1,
    }));
    const promotionBaseline = { rateAtLastPromotion: 0.5, totalCostAtLastPromotion: 100000 };
    const drift = registry.proposeDriftRollback({
      workspaceId: 'ws-a', capabilityId: 'cap-8b', currentEvents, promotionBaseline,
      now: T0 + MIN_TRUSTED_EXECUTIONS * MIN,
    });
    assert.equal(drift.driftDetected, false);
    assert.equal(drift.proposedRollbackReceipt, null);
  });
});

describe('Canary: acceptance test 9 — every promotion/demotion/canary-fail/rollback is an appended, immutable record', () => {
  it('history and promotionReceipts only ever grow; no prior entry is mutated or removed', () => {
    const registry = createCapabilityTrustRegistry();
    for (let i = 0; i < MIN_TRUSTED_EXECUTIONS; i += 1) {
      registry.recordRun({
        workspaceId: 'ws-a', capabilityId: 'cap-9', procedureVersion: 'v1',
        eventId: `v1e${i}`, runId: `v1r${i}`, learningEligibility: 'positive_procedure', occurredAt: T0 + i * MIN,
      });
    }
    const beforeHistory = registry.get('ws-a', 'cap-9').history;
    assert.ok(Object.isFrozen(beforeHistory));
    for (const entry of beforeHistory) assert.ok(Object.isFrozen(entry));

    const admissionRegistry = createPromotionAdmissionRegistry({ resolvePrincipal: VERIFIED });
    admissionRegistry.recordExplicitApproval({
      workspaceId: 'ws-a', capabilityId: 'cap-9', promotionId: 'promo-9', approverId: 'human-1',
    });
    const admission = admissionRegistry.resolveAdmission({ workspaceId: 'ws-a', capabilityId: 'cap-9', promotionId: 'promo-9' });
    const promoted = registry.promoteCanaryCandidate({
      workspaceId: 'ws-a', capabilityId: 'cap-9', candidateProcedureVersion: 'v2',
      canaryResult: { status: CANARY_STATUS.PASSED, reason: 'cleared_baseline' }, admission,
    });

    // The pre-promotion history snapshot is untouched -- new entries are
    // APPENDED to a new frozen array, the old snapshot's own contents
    // (insufficient-data -> probationary -> trusted) are unaffected by
    // anything recorded after the snapshot was taken.
    const beforeHistorySnapshot = beforeHistory.map((h) => ({ ...h }));
    assert.ok(promoted.entry.history.length > beforeHistory.length);
    assert.deepEqual(beforeHistory.map((h) => ({ ...h })), beforeHistorySnapshot);
    assert.ok(Object.isFrozen(promoted.entry.promotionReceipts));
    for (const receipt of promoted.entry.promotionReceipts) assert.ok(Object.isFrozen(receipt));
    assert.equal(promoted.entry.promotionReceipts.length, 1);
    assert.equal(promoted.entry.promotionReceipts[0].kind, 'promotion');

    // A subsequent negative run appends a demotion-relevant history entry
    // without touching the promotion receipt already recorded.
    for (let i = 0; i < 3; i += 1) {
      registry.recordRun({
        workspaceId: 'ws-a', capabilityId: 'cap-9', procedureVersion: 'v2',
        eventId: `v2e${i}`, runId: `v2r${i}`, learningEligibility: 'negative_example',
        occurredAt: T0 + (1000 + i) * MIN,
      });
    }
    const demoted = registry.get('ws-a', 'cap-9');
    assert.equal(demoted.trustState, TRUST_STATES.DEMOTED);
    assert.equal(demoted.promotionReceipts.length, 1); // untouched by demotion
    assert.equal(demoted.promotionReceipts[0].receiptId, promoted.entry.promotionReceipts[0].receiptId);

    // Rollback appends a second, distinct promotionReceipts entry rather
    // than rewriting the first.
    const rollbackAdmissionRegistry = createPromotionAdmissionRegistry({ resolvePrincipal: VERIFIED });
    rollbackAdmissionRegistry.recordExplicitApproval({
      workspaceId: 'ws-a', capabilityId: 'cap-9', promotionId: 'rollback-9', approverId: 'human-2',
    });
    const rollbackAdmission = rollbackAdmissionRegistry.resolveAdmission({
      workspaceId: 'ws-a', capabilityId: 'cap-9', promotionId: 'rollback-9',
    });
    const rolledBack = registry.rollbackToPriorVersion({
      workspaceId: 'ws-a', capabilityId: 'cap-9', targetProcedureVersion: 'v1', admission: rollbackAdmission,
    });
    assert.equal(rolledBack.entry.promotionReceipts.length, 2);
    assert.equal(rolledBack.entry.promotionReceipts[0].receiptId, promoted.entry.promotionReceipts[0].receiptId);
    assert.equal(rolledBack.entry.promotionReceipts[1].kind, 'rollback');

    // Evidence for both versions remains, unmutated, after all of this.
    assert.equal(registry.getEvidenceForVersion('ws-a', 'cap-9', 'v1').totalCount, MIN_TRUSTED_EXECUTIONS);
    assert.equal(registry.getEvidenceForVersion('ws-a', 'cap-9', 'v2').totalCount, 3);
  });
});
