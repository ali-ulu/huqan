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
    const { candidateId } = loop.propose({ workspaceId: 'ws', capabilityId: 'cap', artifactType: 'procedure', candidateVersion: 'v2', proposedBy: 'learner' });
    loop.evaluateCanary({ candidateId, candidateRuns: runs(12, 5), baselineWindowRuns: runs(12, 10), startAt: T0 });
    admissions.recordExplicitApproval({ workspaceId: 'ws', capabilityId: 'cap', promotionId: 'p', approverId: 'learner' });
    loop.promote({ candidateId, promotionId: 'p' });
    assert.equal(trust.get('ws', 'cap').boundProcedureVersion, 'v1');
  };
  assertion(require('../lib/experience/reflective-promotion'));
  const broken = mutant('lib/experience/reflective-promotion.js',
    'promotionId, proposerIds: [candidate.proposedBy, ...learnerPrincipals] });', 'promotionId });');
  assert.throws(() => assertion(broken), { code: 'ERR_ASSERTION' });
});

test('dropping the authority-expansion refusal lets a policy-widening candidate reach promotion', () => {
  const assertion = (moduleExports) => {
    const { loop } = loopWith(moduleExports);
    const res = loop.propose({ workspaceId: 'ws', capabilityId: 'cap', artifactType: 'rule', candidateVersion: 'v2',
      proposedBy: 'learner', authorityDelta: { policy: { allow: ['force_push'] } } });
    assert.equal(res.code, 'authority_expansion');
  };
  assertion(require('../lib/experience/reflective-promotion'));
  const broken = mutant('lib/experience/reflective-promotion.js',
    "if (widened.length) return fail('authority_expansion', { candidateId: candidate.candidateId, widened });", '');
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
