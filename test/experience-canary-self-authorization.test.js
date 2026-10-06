'use strict';

// #3469 (I5): a learner may not authorize its own promotion or rollback. The
// admission must come from the admission registry, name the same capability,
// be used once, and its approver (or the toggle's admin) must not be one of
// the candidate's proposers.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { CANARY_STATUS, createPromotionAdmissionRegistry, isIssuedAdmission } = require('../lib/experience/canary');
const { createCapabilityTrustRegistry } = require('../lib/experience/capability-trust');

const PASSED = Object.freeze({ status: CANARY_STATUS.PASSED, reason: 'cleared_baseline' });
function setup(capabilityId = 'cap-i5') {
  const trust = createCapabilityTrustRegistry();
  trust.createCapability({ workspaceId: 'ws', capabilityId, boundProcedureVersion: 'v1' });
  // Rollback only restores a version with recorded evidence.
  trust.recordRun({ workspaceId: 'ws', capabilityId, procedureVersion: 'v1', eventId: `${capabilityId}-e1`,
    runId: `${capabilityId}-r1`, learningEligibility: 'positive_procedure', occurredAt: Date.parse('2026-01-01T00:00:00Z') });
  return { trust, admissions: createPromotionAdmissionRegistry() };
}
function approve(admissions, { approverId, promotionId = 'p1', capabilityId = 'cap-i5', proposerIds } = {}) {
  admissions.recordExplicitApproval({ workspaceId: 'ws', capabilityId, promotionId, approverId });
  return admissions.resolveAdmission({ workspaceId: 'ws', capabilityId, promotionId, proposerIds });
}

describe('I5 admission: the proposer cannot be the authority', () => {
  it('refuses and consumes an approval given by a proposer', () => {
    const { admissions } = setup();
    const admission = approve(admissions, { approverId: 'learner-1', proposerIds: ['learner-1'] });
    assert.equal(admission.admitted, false);
    assert.equal(admission.code, 'self_authorization_refused');
    // The self-approval is spent: asking again without proposerIds cannot launder it.
    const replay = admissions.resolveAdmission({ workspaceId: 'ws', capabilityId: 'cap-i5', promotionId: 'p1' });
    assert.equal(replay.admitted, false);
  });

  it('refuses a standing auto-promote toggle that a proposer switched on', () => {
    const { admissions } = setup();
    admissions.setAutoPromoteToggle({ workspaceId: 'ws', capabilityId: 'cap-i5', adminId: 'learner-1', enabled: true });
    const admission = admissions.resolveAdmission({ workspaceId: 'ws', capabilityId: 'cap-i5', promotionId: 'p2', proposerIds: ['learner-1'] });
    assert.equal(admission.admitted, false);
    assert.equal(admission.code, 'self_authorization_refused');
  });

  it('admits an independent approver and marks the admission as issued', () => {
    const { admissions } = setup();
    const admission = approve(admissions, { approverId: 'human-1', proposerIds: ['learner-1'] });
    assert.equal(admission.admitted, true);
    assert.equal(isIssuedAdmission(admission), true);
    assert.equal(isIssuedAdmission({ ...admission }), false, 'a copy is not the issued admission');
  });

  it('rejects a malformed proposer list instead of skipping the check', () => {
    const { admissions } = setup();
    admissions.recordExplicitApproval({ workspaceId: 'ws', capabilityId: 'cap-i5', promotionId: 'p3', approverId: 'human-1' });
    assert.equal(admissions.resolveAdmission({ workspaceId: 'ws', capabilityId: 'cap-i5', promotionId: 'p3', proposerIds: 'learner-1' }).code,
      'invalid_admission_request');
  });
});

describe('I5 promotion and rollback accept only issued, matching, single-use admissions', () => {
  it('a hand-written admitted:true object cannot promote', () => {
    const { trust } = setup();
    const res = trust.promoteCanaryCandidate({ workspaceId: 'ws', capabilityId: 'cap-i5', candidateProcedureVersion: 'v2',
      canaryResult: PASSED, admission: { ok: true, admitted: true, mode: 'explicit_approval' } });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'promotion_not_admitted');
    assert.equal(trust.get('ws', 'cap-i5').boundProcedureVersion, 'v1');
  });

  it('an admission issued for another capability cannot promote this one', () => {
    const { trust, admissions } = setup();
    trust.createCapability({ workspaceId: 'ws', capabilityId: 'other', boundProcedureVersion: 'v1' });
    const admission = approve(admissions, { approverId: 'human-1', capabilityId: 'other' });
    const res = trust.promoteCanaryCandidate({ workspaceId: 'ws', capabilityId: 'cap-i5', candidateProcedureVersion: 'v2',
      canaryResult: PASSED, admission });
    assert.equal(res.code, 'admission_subject_mismatch');
  });

  it('one admission authorizes one move: it cannot also authorize a rollback or a second promotion', () => {
    const { trust, admissions } = setup();
    const admission = approve(admissions, { approverId: 'human-1' });
    assert.equal(trust.promoteCanaryCandidate({ workspaceId: 'ws', capabilityId: 'cap-i5', candidateProcedureVersion: 'v2',
      canaryResult: PASSED, admission }).ok, true);
    const again = trust.rollbackToPriorVersion({ workspaceId: 'ws', capabilityId: 'cap-i5', targetProcedureVersion: 'v1', admission });
    assert.equal(again.code, 'admission_already_used');
    assert.equal(trust.get('ws', 'cap-i5').boundProcedureVersion, 'v2');
    const rollbackAdmission = approve(admissions, { approverId: 'human-2', promotionId: 'rb-1' });
    assert.equal(trust.rollbackToPriorVersion({ workspaceId: 'ws', capabilityId: 'cap-i5', targetProcedureVersion: 'v1',
      admission: rollbackAdmission }).ok, true);
  });
});
