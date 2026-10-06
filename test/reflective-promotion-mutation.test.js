'use strict';

// #3469: each authority guard is load-bearing. Removing it must turn the
// acceptance assertion red.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { createPromotionAdmissionRegistry } = require('../lib/experience/canary');
const { createCapabilityTrustRegistry } = require('../lib/experience/capability-trust');
const { createCanaryExtension } = require('../lib/experience/capability-trust-canary-extension');

function mutant(relative, original, replacement) {
  const file = path.resolve(__dirname, '..', relative);
  const source = fs.readFileSync(file, 'utf8');
  assert.equal(source.split(original).length - 1, 1, 'mutation must have exactly one target');
  const compiledFile = file.replace(/\.js$/, '.mutant.cjs');
  const compiled = new Module(compiledFile, module);
  compiled.filename = compiledFile;
  compiled.paths = module.paths;
  compiled._compile(source.replace(original, replacement), compiledFile);
  return compiled.exports;
}
const T0 = Date.parse('2026-01-01T00:00:00Z');
// #3551: derivation inputs. Same scope both sides so the diff derives no
// widening and the pre-existing assertions keep testing what they tested.
const SCOPE = Object.freeze({ tools: Object.freeze(['read']) });
const WIDER_SCOPE = Object.freeze({ tools: Object.freeze(['read', 'write']) });
function artifacts(scope = SCOPE) {
  return { candidateArtifact: { scope }, boundArtifact: { scope: SCOPE } };
}
function runs(count, cost) {
  return Array.from({ length: count }, (_, i) => ({ occurredAt: T0 + i * 60000, learningEligibility: 'positive_procedure',
    executionCost: cost, verificationCost: 1, canaryOverheadCost: 0 }));
}
function loopWith({ createReflectivePromotion }, admissions = createPromotionAdmissionRegistry()) {
  const trust = createCapabilityTrustRegistry();
  trust.createCapability({ workspaceId: 'ws', capabilityId: 'cap', boundProcedureVersion: 'v1' });
  return { trust, admissions, loop: createReflectivePromotion({ trust, admissions, learnerPrincipals: ['learner'] }) };
}

test('not passing the proposers to the admission registry breaks the self-approval refusal', () => {
  const assertion = (moduleExports) => {
    const { trust, admissions, loop } = loopWith(moduleExports);
    const { candidateId } = loop.propose({ workspaceId: 'ws', capabilityId: 'cap', artifactType: 'procedure', candidateVersion: 'v2', proposedBy: 'learner', authorityDelta: {}, ...artifacts() });
    loop.evaluateCanary({ candidateId, candidateRuns: runs(12, 5), baselineWindowRuns: runs(12, 10), startAt: T0 });
    admissions.recordExplicitApproval({ workspaceId: 'ws', capabilityId: 'cap', promotionId: 'p', approverId: 'learner',
      subject: { kind: 'promotion', candidateVersion: 'v2' } });
    loop.promote({ candidateId, promotionId: 'p' });
    assert.equal(trust.get('ws', 'cap').boundProcedureVersion, 'v1');
  };
  assertion(require('../lib/experience/reflective-promotion'));
  const broken = mutant('lib/experience/reflective-promotion.js',
    'proposerIds: [candidate.proposedBy, ...learnerPrincipals],', 'proposerIds: [],');
  assert.throws(() => assertion(broken), { code: 'ERR_ASSERTION' });
});

test('dropping the authority-expansion refusal lets a policy-widening candidate reach promotion', () => {
  const assertion = (moduleExports) => {
    const { loop } = loopWith(moduleExports);
    const res = loop.propose({ workspaceId: 'ws', capabilityId: 'cap', artifactType: 'rule', candidateVersion: 'v2',
      proposedBy: 'learner', authorityDelta: { policy: { allow: ['force_push'] } }, ...artifacts() });
    assert.equal(res.code, 'authority_expansion');
  };
  assertion(require('../lib/experience/reflective-promotion'));
  const broken = mutant('lib/experience/reflective-promotion.js',
    'if (refusal) outcome = { code: refusal.code, widened: refusal.widened || [] };',
    'if (false) outcome = { code: refusal.code, widened: refusal.widened || [] };');
  assert.throws(() => assertion(broken), { code: 'ERR_ASSERTION' });
});

test('skipping the proposer check in the admission registry breaks the self-approval refusal', () => {
  const assertion = ({ createPromotionAdmissionRegistry: create }) => {
    const admissions = create();
    admissions.recordExplicitApproval({ workspaceId: 'ws', capabilityId: 'cap', promotionId: 'p', approverId: 'learner' });
    assert.equal(admissions.resolveAdmission({ workspaceId: 'ws', capabilityId: 'cap', promotionId: 'p', proposerIds: ['learner'] }).admitted, false);
  };
  assertion(require('../lib/experience/canary-admission'));
  const broken = mutant('lib/experience/canary-admission.js', 'if (proposers.has(approval.approverId)) {', 'if (false) {');
  assert.throws(() => assertion(broken), { code: 'ERR_ASSERTION' });
});

test('accepting any admitted:true object again lets a forged admission promote', () => {
  const assertion = ({ createCanaryExtension: create }) => {
    const record = { boundProcedureVersion: 'v1', promotionReceipts: [], history: [], events: [] };
    const ext = create({ records: new Map([['ws::cap', record]]), compositeKey: (w, c) => `${w}::${c}`,
      nonEmptyString: (v) => typeof v === 'string' && v.length > 0,
      rebindProcedure: ({ newProcedureVersion }) => { record.boundProcedureVersion = newProcedureVersion; return { ok: true }; },
      toPublicEntry: (r) => ({ ...r }) });
    ext.promoteCanaryCandidate({ workspaceId: 'ws', capabilityId: 'cap', candidateProcedureVersion: 'v2',
      canaryResult: { status: 'passed' },
      // A forger copies every field a real admission has, including a matching receipt.
      admission: { ok: true, admitted: true, mode: 'explicit_approval',
        receipt: { workspaceId: 'ws', capabilityId: 'cap', promotionId: 'p', approverId: 'human' } } });
    assert.equal(record.boundProcedureVersion, 'v1');
  };
  assertion({ createCanaryExtension });
  const broken = mutant('lib/experience/capability-trust-canary-extension.js',
    'if (!isIssuedAdmission(admission)) return notAdmittedCode;', 'if (admission?.admitted !== true) return notAdmittedCode;');
  assert.throws(() => assertion(broken), { code: 'ERR_ASSERTION' });
});

test('ignoring the admission subject in the ladder lets an approval for another version promote this one', () => {
  const assertion = ({ createCanaryExtension: create }) => {
    const admissions = createPromotionAdmissionRegistry();
    admissions.recordExplicitApproval({ workspaceId: 'ws', capabilityId: 'cap', promotionId: 'p', approverId: 'human',
      subject: { kind: 'promotion', candidateVersion: 'v9' } });
    const admission = admissions.resolveAdmission({ workspaceId: 'ws', capabilityId: 'cap', promotionId: 'p',
      subject: { kind: 'promotion', candidateVersion: 'v9' } });
    const record = { boundProcedureVersion: 'v1', promotionReceipts: [], history: [], events: [] };
    const ext = create({ records: new Map([['ws::cap', record]]), compositeKey: (w, c) => `${w}::${c}`,
      nonEmptyString: (v) => typeof v === 'string' && v.length > 0,
      rebindProcedure: ({ newProcedureVersion }) => { record.boundProcedureVersion = newProcedureVersion; return { ok: true }; },
      toPublicEntry: (r) => ({ ...r }) });
    ext.promoteCanaryCandidate({ workspaceId: 'ws', capabilityId: 'cap', candidateProcedureVersion: 'v2', canaryResult: { status: 'passed' }, admission });
    assert.equal(record.boundProcedureVersion, 'v1');
  };
  assertion({ createCanaryExtension });
  const broken = mutant('lib/experience/capability-trust-canary-extension.js',
    '|| (receipt.subject && (receipt.subject.kind !== move.kind || receipt.subject.candidateVersion !== move.candidateVersion))', '');
  assert.throws(() => assertion(broken), { code: 'ERR_ASSERTION' });
});

test('dropping the stale-prior check lets a second candidate overwrite a promotion its canary never compared against', () => {
  const assertion = (moduleExports) => {
    const { trust, admissions, loop } = loopWith(moduleExports);
    const ids = ['v2', 'v3'].map((candidateVersion) => {
      const { candidateId } = loop.propose({ workspaceId: 'ws', capabilityId: 'cap', artifactType: 'procedure', candidateVersion, proposedBy: 'learner', authorityDelta: {}, ...artifacts() });
      loop.evaluateCanary({ candidateId, candidateRuns: runs(12, 5), baselineWindowRuns: runs(12, 10), startAt: T0 });
      admissions.recordExplicitApproval({ workspaceId: 'ws', capabilityId: 'cap', promotionId: candidateVersion, approverId: 'human',
        subject: { kind: 'promotion', candidateVersion } });
      return candidateId;
    });
    loop.promote({ candidateId: ids[0], promotionId: 'v2' });
    loop.promote({ candidateId: ids[1], promotionId: 'v3' });
    assert.equal(trust.get('ws', 'cap').boundProcedureVersion, 'v2');
  };
  assertion(require('../lib/experience/reflective-promotion'));
  const broken = mutant('lib/experience/reflective-promotion.js',
    "if (boundVersion(candidate) !== candidate.priorVersion) return fail('stale_prior_version');", '');
  assert.throws(() => assertion(broken), { code: 'ERR_ASSERTION' });
});

test('dropping the declaration-mismatch refusal lets a silently widening candidate promote', () => {
  const assertion = (moduleExports) => {
    const { trust, admissions, loop } = loopWith(moduleExports);
    const { candidateId } = loop.propose({ workspaceId: 'ws', capabilityId: 'cap', artifactType: 'procedure', candidateVersion: 'v2',
      proposedBy: 'learner', authorityDelta: {},
      candidateArtifact: { scope: WIDER_SCOPE }, boundArtifact: { scope: SCOPE } });
    loop.evaluateCanary({ candidateId, candidateRuns: runs(12, 5), baselineWindowRuns: runs(12, 10), startAt: T0 });
    admissions.recordExplicitApproval({ workspaceId: 'ws', capabilityId: 'cap', promotionId: 'p', approverId: 'human',
      subject: { kind: 'promotion', candidateVersion: 'v2' } });
    loop.promote({ candidateId, promotionId: 'p' });
    assert.equal(trust.get('ws', 'cap').boundProcedureVersion, 'v1');
  };
  assertion(require('../lib/experience/reflective-promotion'));
  const broken = mutant('lib/experience/reflective-promotion.js',
    'else if ((impact.widened || []).length > 0) outcome = { code:', 'else if (false) outcome = { code:');
  assert.throws(() => assertion(broken), { code: 'ERR_ASSERTION' });
});

test('dropping the underivable refusal lets an artifact-free proposal promote', () => {
  const assertion = (moduleExports) => {
    const { trust, admissions, loop } = loopWith(moduleExports);
    const { candidateId } = loop.propose({ workspaceId: 'ws', capabilityId: 'cap', artifactType: 'procedure', candidateVersion: 'v2',
      proposedBy: 'learner', authorityDelta: {} });
    loop.evaluateCanary({ candidateId, candidateRuns: runs(12, 5), baselineWindowRuns: runs(12, 10), startAt: T0 });
    admissions.recordExplicitApproval({ workspaceId: 'ws', capabilityId: 'cap', promotionId: 'p', approverId: 'human',
      subject: { kind: 'promotion', candidateVersion: 'v2' } });
    loop.promote({ candidateId, promotionId: 'p' });
    assert.equal(trust.get('ws', 'cap').boundProcedureVersion, 'v1');
  };
  assertion(require('../lib/experience/reflective-promotion'));
  const broken = mutant('lib/experience/reflective-promotion.js',
    'else if (impact.underivable) outcome = { code:', 'else if (false) outcome = { code:');
  assert.throws(() => assertion(broken), { code: 'ERR_ASSERTION' });
});
