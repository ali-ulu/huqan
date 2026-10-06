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
    proposedBy: 'learner-agent', authorityDelta: {}, ...artifacts(), ...overrides });
  assert.equal(proposal.ok, true);
  const canary = loop.evaluateCanary({ candidateId: proposal.candidateId, candidateRuns: runs(12, { cost: 5 }),
    baselineWindowRuns: runs(12, { cost: 10 }), startAt: T0 });
  assert.equal(canary.state, STATES.CANARY_PASSED);
  return proposal.candidateId;
}
function approve(admissions, promotionId, approverId, kind = 'promotion', candidateVersion = 'v2') {
  admissions.recordExplicitApproval({ workspaceId: 'ws', capabilityId: 'cap', promotionId, approverId, subject: { kind, candidateVersion } });
}
// #3551: artifacts the derivation reads. Same scope both sides means the
// diff derives no widening; anything else exercises mismatch or underivable.
const SCOPE = Object.freeze({ tools: Object.freeze(['read']) });
const WIDER_SCOPE = Object.freeze({ tools: Object.freeze(['read', 'write']) });
function artifacts(scope = SCOPE) {
  return { candidateArtifact: { scope }, boundArtifact: { scope: SCOPE } };
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
      assert.equal(res.code, surface === 'unknownSurface' ? 'invalid_authority_delta' : 'authority_expansion', surface);
      assert.equal(loop.evaluateCanary({ candidateId: res.candidateId, candidateRuns: runs(12, { cost: 5 }),
        baselineWindowRuns: runs(12), startAt: T0 }).code, 'invalid_state');
      assert.equal(loop.promote({ candidateId: res.candidateId, promotionId: 'p' }).code, 'invalid_state');
    }
    const { loop } = setup();
    assert.equal(loop.propose({ workspaceId: 'ws', capabilityId: 'cap', artifactType: 'model', candidateVersion: 'v2',
      proposedBy: 'learner-agent', authorityDelta: { scope: null, policy: null }, ...artifacts() }).ok, true);
  });

  it('cannot promote without a computed canary pass, and a failed canary stays unpromoted', () => {
    const { admissions, loop } = setup();
    const proposal = loop.propose({ workspaceId: 'ws', capabilityId: 'cap', artifactType: 'procedure', candidateVersion: 'v2', proposedBy: 'learner-agent', authorityDelta: {}, ...artifacts() });
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
    assert.equal(loop.propose({ workspaceId: 'ws', capabilityId: 'nope', artifactType: 'rule', candidateVersion: 'v2', proposedBy: 'x', authorityDelta: {} }).code, 'not_found');
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
    approve(admissions, 'rb1', 'learner-agent', 'rollback');
    assert.equal(loop.rollback({ candidateId: id, promotionId: 'rb1' }).code, 'self_authorization_refused');
    approve(admissions, 'rb2', 'human-reviewer', 'rollback');
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

describe('I5 review hardening: bound approvals, declared deltas, stale versions', () => {
  function bound(admissions, promotionId, approverId, kind, candidateVersion) {
    admissions.recordExplicitApproval({ workspaceId: 'ws', capabilityId: 'cap', promotionId, approverId, subject: { kind, candidateVersion } });
  }
  it('an approval bound to one candidate version or direction cannot authorize another', () => {
    const { trust, admissions, loop } = setup();
    const a = proposeAndPass(loop);
    const b = proposeAndPass(loop, { candidateVersion: 'v3' });
    bound(admissions, 'p1', 'human-reviewer', 'promotion', 'v2');
    assert.equal(loop.promote({ candidateId: b, promotionId: 'p1' }).code, 'admission_subject_mismatch');
    assert.equal(trust.get('ws', 'cap').boundProcedureVersion, 'v1');
    assert.equal(loop.promote({ candidateId: a, promotionId: 'p1' }).ok, true, 'a mismatched request does not burn the approval');
    bound(admissions, 'p2', 'human-reviewer', 'promotion', 'v2');
    assert.equal(loop.rollback({ candidateId: a, promotionId: 'p2' }).code, 'admission_subject_mismatch');
  });

  it('an unbound approval does not authorize the loop', () => {
    const { admissions, loop } = setup();
    const id = proposeAndPass(loop);
    admissions.recordExplicitApproval({ workspaceId: 'ws', capabilityId: 'cap', promotionId: 'p1', approverId: 'human-reviewer' });
    assert.equal(loop.promote({ candidateId: id, promotionId: 'p1' }).code, 'unbound_approval');
  });

  it('the ladder refuses an issued admission bound to another version or direction', () => {
    const { trust, admissions } = setup();
    bound(admissions, 'p1', 'human-reviewer', 'promotion', 'v9');
    const admission = admissions.resolveAdmission({ workspaceId: 'ws', capabilityId: 'cap', promotionId: 'p1', subject: { kind: 'promotion', candidateVersion: 'v9' } });
    assert.equal(trust.promoteCanaryCandidate({ workspaceId: 'ws', capabilityId: 'cap', candidateProcedureVersion: 'v2',
      canaryResult: { status: 'passed' }, admission }).code, 'admission_subject_mismatch');
  });

  it('a missing, non-plain, hidden-key or proxied authority declaration is refused', () => {
    const hidden = {};
    Object.defineProperty(hidden, 'scope', { value: { widen: true }, enumerable: false });
    const deltas = [undefined, Object.create({ scope: '*' }), new Map([['scope', '*']]), hidden,
      { [Symbol('policy')]: '*' }, new Proxy({}, { ownKeys: () => [] }), [], 'none'];
    for (const authorityDelta of deltas) {
      const { loop } = setup();
      const res = loop.propose({ workspaceId: 'ws', capabilityId: 'cap', artifactType: 'rule', candidateVersion: 'v2', proposedBy: 'learner-agent', authorityDelta });
      assert.equal(res.ok, false, String(authorityDelta));
    }
  });

  it('promotion refuses a stale prior version and rollback refuses a version that is no longer bound', () => {
    const { trust, admissions, loop } = setup();
    const a = proposeAndPass(loop);
    const b = proposeAndPass(loop, { candidateVersion: 'v3' });
    bound(admissions, 'pa', 'human-reviewer', 'promotion', 'v2');
    assert.equal(loop.promote({ candidateId: a, promotionId: 'pa' }).ok, true);
    bound(admissions, 'pb', 'human-reviewer', 'promotion', 'v3');
    assert.equal(loop.promote({ candidateId: b, promotionId: 'pb' }).code, 'stale_prior_version');
    assert.equal(trust.get('ws', 'cap').boundProcedureVersion, 'v2');
    const baseline = loop.inspect(a).promotionBaseline;
    assert.throws(() => { baseline.rateAtLastPromotion = 1; });
  });
});

describe('#3551 derived authority impact: mismatch refusal and fail-closed underivable', () => {
  function base(overrides = {}) {
    return { workspaceId: 'ws', capabilityId: 'cap', artifactType: 'procedure', candidateVersion: 'v2',
      proposedBy: 'learner-agent', authorityDelta: {}, ...overrides };
  }
  it('a scope the declaration stays silent about is refused as a declaration mismatch', () => {
    const { loop } = setup();
    const res = loop.propose(base( { candidateArtifact: { scope: WIDER_SCOPE }, boundArtifact: { scope: SCOPE } }));
    assert.equal(res.code, 'authority_declaration_mismatch');
    assert.deepEqual(res.widened, ['scope']);
    assert.equal(loop.evaluateCanary({ candidateId: res.candidateId, candidateRuns: runs(12, { cost: 5 }),
      baselineWindowRuns: runs(12), startAt: T0 }).code, 'invalid_state');
    assert.equal(loop.promote({ candidateId: res.candidateId, promotionId: 'p' }).code, 'invalid_state');
  });

  it('a narrowed scope is also a mismatch: narrowing through learning is refused too', () => {
    const { loop } = setup();
    const res = loop.propose(base( { candidateArtifact: { scope: SCOPE }, boundArtifact: { scope: WIDER_SCOPE } }));
    assert.equal(res.code, 'authority_declaration_mismatch');
  });

  it('a declared widening still refuses as authority_expansion before any artifact is read', () => {
    const { loop } = setup();
    const res = loop.propose(base( { authorityDelta: { scope: { widen: true } } }));
    assert.equal(res.code, 'authority_expansion');
  });

  it('missing, non-record, proxied or scopeless artifacts fail closed as underivable', () => {
    const cases = [
      {},
      { candidateArtifact: { scope: SCOPE } },
      { candidateArtifact: { scope: SCOPE }, boundArtifact: null },
      { candidateArtifact: new Proxy({ scope: SCOPE }, {}), boundArtifact: { scope: SCOPE } },
      { candidateArtifact: { scope: SCOPE }, boundArtifact: { scope: [SCOPE] } },
    ];
    for (const extra of cases) {
      const { loop } = setup();
      const res = loop.propose(base( extra));
      assert.equal(res.code, 'authority_impact_underivable', JSON.stringify(Object.keys(extra)));
      assert.equal(loop.promote({ candidateId: res.candidateId, promotionId: 'p' }).code, 'invalid_state');
    }
  });

  it('hidden scope keys cannot smuggle a widening past the derivation', () => {
    const sneaky = { scope: { ...SCOPE } };
    Object.defineProperty(sneaky.scope, 'extra', { value: ['admin'], enumerable: false });
    const { loop } = setup();
    const res = loop.propose(base({ candidateArtifact: sneaky, boundArtifact: { scope: SCOPE } }));
    assert.equal(res.code, 'authority_declaration_mismatch');
  });

  it('rule and model types derive from scope-carrying artifacts the same way', () => {
    for (const artifactType of ['rule', 'model']) {
      const { loop } = setup();
      const same = loop.propose(base({ artifactType, ...artifacts() }));
      assert.equal(same.ok, true, artifactType);
      const { loop: loop2 } = setup();
      const diff = loop2.propose(base({ artifactType,
        candidateArtifact: { scope: WIDER_SCOPE }, boundArtifact: { scope: SCOPE } }));
      assert.equal(diff.code, 'authority_declaration_mismatch', artifactType);
    }
  });
});
