'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createPromotionAdmissionRegistry } = require('../lib/experience/canary');
const { createCapabilityTrustRegistry } = require('../lib/experience/capability-trust');
const { createReflectivePromotion, STATES } = require('../lib/experience/reflective-promotion');

const T0 = Date.parse('2026-01-01T00:00:00Z');
const MIN = 60 * 1000;
function runs(count, { cost = 10, negatives = 0, from = 0 } = {}) {
  return Array.from({ length: count }, (_, i) => ({ occurredAt: T0 + (from + i) * MIN,
    learningEligibility: i < negatives ? 'negative_example' : 'positive_procedure',
    executionCost: cost, verificationCost: 1, canaryOverheadCost: 0, eventId: `e${from + i}`, runId: `r${from + i}` }));
}
function setup({ learnerPrincipals = ['learner-agent'] } = {}) {
  const trust = createCapabilityTrustRegistry();
  trust.createCapability({ workspaceId: 'ws', capabilityId: 'cap', boundProcedureVersion: 'v1' });
  trust.recordRun({ workspaceId: 'ws', capabilityId: 'cap', procedureVersion: 'v1', eventId: 'v1e', runId: 'v1r',
    learningEligibility: 'positive_procedure', occurredAt: T0 });
  const admissions = createPromotionAdmissionRegistry();
  const loop = createReflectivePromotion({ trust, admissions, learnerPrincipals });
  return { trust, admissions, loop };
}
function proposeAndPass(loop, overrides = {}) {
  const proposal = loop.propose({ workspaceId: 'ws', capabilityId: 'cap', artifactType: 'procedure', candidateVersion: 'v2',
    proposedBy: 'learner-agent', ...overrides });
  assert.equal(proposal.ok, true);
  const canary = loop.evaluateCanary({ candidateId: proposal.candidateId, candidateRuns: runs(12, { cost: 5 }),
    baselineWindowRuns: runs(12, { cost: 10 }), startAt: T0 });
  assert.equal(canary.state, STATES.CANARY_PASSED);
  return proposal.candidateId;
}
function approve(admissions, promotionId, approverId) {
  admissions.recordExplicitApproval({ workspaceId: 'ws', capabilityId: 'cap', promotionId, approverId });
}

describe('I5 reflective loop: canary -> independent admission -> promote', () => {
  it('promotes a canary-passed candidate only with an approver who is not a learner', () => {
    const { trust, admissions, loop } = setup();
    const id = proposeAndPass(loop);
    approve(admissions, 'p1', 'human-reviewer');
    const promoted = loop.promote({ candidateId: id, promotionId: 'p1' });
    assert.equal(promoted.ok, true);
    assert.equal(trust.get('ws', 'cap').boundProcedureVersion, 'v2');
    assert.deepEqual(loop.auditTrail().map((e) => e.event), ['proposed', 'canary_evaluated', 'promoted']);
  });

  it('refuses the proposer, any other learner principal and a learner-owned toggle as authority', () => {
    const { trust, admissions, loop } = setup({ learnerPrincipals: ['learner-agent', 'reflection-worker'] });
    const id = proposeAndPass(loop);
    approve(admissions, 'p1', 'learner-agent');
    assert.equal(loop.promote({ candidateId: id, promotionId: 'p1' }).code, 'self_authorization_refused');
    approve(admissions, 'p2', 'reflection-worker');
    assert.equal(loop.promote({ candidateId: id, promotionId: 'p2' }).code, 'self_authorization_refused');
    admissions.setAutoPromoteToggle({ workspaceId: 'ws', capabilityId: 'cap', adminId: 'reflection-worker', enabled: true });
    assert.equal(loop.promote({ candidateId: id, promotionId: 'p3' }).code, 'self_authorization_refused');
    assert.equal(trust.get('ws', 'cap').boundProcedureVersion, 'v1');
    admissions.setAutoPromoteToggle({ workspaceId: 'ws', capabilityId: 'cap', adminId: 'operator-admin', enabled: true });
    assert.equal(loop.promote({ candidateId: id, promotionId: 'p4' }).ok, true);
  });

  it('refuses a learned change that touches scope, policy, approval or capability, before any canary', () => {
    for (const surface of ['scope', 'policy', 'approval', 'capability', 'unknownSurface']) {
      const { loop } = setup();
      const res = loop.propose({ workspaceId: 'ws', capabilityId: 'cap', artifactType: 'rule', candidateVersion: 'v2',
        proposedBy: 'learner-agent', authorityDelta: { [surface]: { add: ['*'] } } });
      assert.equal(res.code, 'authority_expansion', surface);
      assert.equal(loop.evaluateCanary({ candidateId: res.candidateId, candidateRuns: runs(12, { cost: 5 }),
        baselineWindowRuns: runs(12), startAt: T0 }).code, 'invalid_state');
      assert.equal(loop.promote({ candidateId: res.candidateId, promotionId: 'p' }).code, 'invalid_state');
    }
    const { loop } = setup();
    assert.equal(loop.propose({ workspaceId: 'ws', capabilityId: 'cap', artifactType: 'model', candidateVersion: 'v2',
      proposedBy: 'learner-agent', authorityDelta: { scope: null, policy: null } }).ok, true);
  });

  it('cannot promote without a computed canary pass, and a failed canary stays unpromoted', () => {
    const { admissions, loop } = setup();
    const proposal = loop.propose({ workspaceId: 'ws', capabilityId: 'cap', artifactType: 'procedure', candidateVersion: 'v2', proposedBy: 'learner-agent' });
    approve(admissions, 'p1', 'human-reviewer');
    assert.equal(loop.promote({ candidateId: proposal.candidateId, promotionId: 'p1' }).code, 'invalid_state');
    const failed = loop.evaluateCanary({ candidateId: proposal.candidateId, candidateRuns: runs(12, { cost: 50 }),
      baselineWindowRuns: runs(12, { cost: 10 }), startAt: T0 });
    assert.equal(failed.state, STATES.CANARY_FAILED);
    assert.equal(loop.promote({ candidateId: proposal.candidateId, promotionId: 'p1' }).code, 'invalid_state');
  });

  it('rejects malformed input and unknown artifact types', () => {
    const { loop } = setup();
    assert.equal(loop.propose({ workspaceId: 'ws', capabilityId: 'cap', artifactType: 'policy', candidateVersion: 'v2', proposedBy: 'x' }).code, 'invalid_proposal');
    assert.equal(loop.propose({ workspaceId: 'ws', capabilityId: 'nope', artifactType: 'rule', candidateVersion: 'v2', proposedBy: 'x' }).code, 'not_found');
    assert.throws(() => createReflectivePromotion({}), /required/);
    assert.equal(loop.inspect('missing').code, 'unknown_candidate');
  });
});

describe('I5 reflective loop: observe -> proposed rollback -> independent rollback', () => {
  it('a late regression proposes a rollback that only a non-learner authority can apply', () => {
    const { trust, admissions, loop } = setup();
    const id = proposeAndPass(loop);
    approve(admissions, 'p1', 'human-reviewer');
    loop.promote({ candidateId: id, promotionId: 'p1' });
    const healthy = loop.observe({ candidateId: id, currentEvents: runs(12, { cost: 5, from: 100 }), now: T0 + 200 * MIN });
    assert.equal(healthy.driftDetected, false);
    const drifted = loop.observe({ candidateId: id, currentEvents: runs(12, { cost: 5, negatives: 6, from: 100 }), now: T0 + 200 * MIN });
    assert.equal(drifted.driftDetected, true);
    assert.equal(drifted.state, STATES.ROLLBACK_PROPOSED);
    assert.equal(trust.get('ws', 'cap').boundProcedureVersion, 'v2', 'observation alone never reverts');
    approve(admissions, 'rb1', 'learner-agent');
    assert.equal(loop.rollback({ candidateId: id, promotionId: 'rb1' }).code, 'self_authorization_refused');
    approve(admissions, 'rb2', 'human-reviewer');
    const rolled = loop.rollback({ candidateId: id, promotionId: 'rb2' });
    assert.equal(rolled.ok, true);
    assert.equal(trust.get('ws', 'cap').boundProcedureVersion, 'v1');
    assert.deepEqual(loop.auditTrail().map((e) => e.event),
      ['proposed', 'canary_evaluated', 'promoted', 'rollback_proposed', 'rollback_refused', 'rolled_back']);
    assert.equal(loop.inspect(id).state, STATES.ROLLED_BACK);
  });

  it('a cost regression alone also proposes a rollback', () => {
    const { admissions, loop } = setup();
    const id = proposeAndPass(loop);
    approve(admissions, 'p1', 'human-reviewer');
    loop.promote({ candidateId: id, promotionId: 'p1' });
    assert.equal(loop.observe({ candidateId: id, currentEvents: runs(12, { cost: 40, from: 100 }), now: T0 + 200 * MIN }).driftDetected, true);
  });

  it('the audit trail is append-only and frozen', () => {
    const { loop } = setup();
    proposeAndPass(loop);
    const trail = loop.auditTrail();
    assert.ok(Object.isFrozen(trail));
    assert.ok(trail.every((entry) => Object.isFrozen(entry)));
    assert.throws(() => { trail.push({}); });
  });
});
