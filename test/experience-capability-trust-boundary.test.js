'use strict';

/**
 * #3552 — the Capability Trust boundary is load-bearing, so each guard is
 * characterized AND mutation-tested: removing it must turn the acceptance
 * assertion red.
 *
 * 1. `rebindProcedure` is not on the registry's public surface: holding the
 *    registry object does not authorize changing a bound version.
 * 2. Admission ids (approver/admin) are resolved through an injected
 *    verifier — `recordExplicitApproval`/`setAutoPromoteToggle` accept a
 *    subject reference only after the host's identity layer vouches for it,
 *    so an arbitrary string can no longer authorize a promotion.
 * 3. The reflective loop refuses to start without learner principals, so
 *    the self-authorization check cannot be silently emptied.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { createCapabilityTrustRegistry } = require('../lib/experience/capability-trust');
const {
  createPromotionAdmissionRegistry, isIssuedAdmission,
} = require('../lib/experience/canary-admission');

function mutant(relative, original, replacement) {
  const file = path.resolve(__dirname, '..', relative);
  // Normalize line endings so a mutation target written in the test matches
  // on both CRLF (Windows checkout) and LF (CI) sources.
  const source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  original = original.replace(/\r\n/g, '\n');
  replacement = replacement.replace(/\r\n/g, '\n');
  assert.equal(source.split(original).length - 1, 1, 'mutation must have exactly one target');
  const compiledFile = file.replace(/\.js$/, '.mutant.cjs');
  const compiled = new Module(compiledFile, module);
  compiled.filename = compiledFile;
  compiled.paths = module.paths;
  compiled._compile(source.replace(original, replacement), compiledFile);
  return compiled.exports;
}

const HOST_RESOLVER = (reference) => (reference === 'human-1'
  ? { ok: true, principal: { id: 'human-1', kind: 'human', status: 'active' } }
  : { ok: false, code: 'unknown_principal' });

test('rebindProcedure is not on the public registry surface', () => {
  const registry = createCapabilityTrustRegistry();
  registry.createCapability({ workspaceId: 'ws', capabilityId: 'cap', boundProcedureVersion: 'v1' });
  assert.equal(registry.rebindProcedure, undefined,
    'holding the registry must not be authority to rebind');
  assert.equal(typeof registry.promoteCanaryCandidate, 'function');
  assert.equal(typeof registry.rollbackToPriorVersion, 'function');
});

test('a binding only moves through the admission-gated canary path', () => {
  const registry = createCapabilityTrustRegistry();
  registry.createCapability({ workspaceId: 'ws', capabilityId: 'cap', boundProcedureVersion: 'v1' });
  const refused = registry.promoteCanaryCandidate({
    workspaceId: 'ws', capabilityId: 'cap', candidateProcedureVersion: 'v2',
    canaryResult: { status: 'passed' }, admission: { ok: true, admitted: true, mode: 'explicit_approval', receipt: {} },
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'promotion_not_admitted');
  assert.equal(registry.get('ws', 'cap').boundProcedureVersion, 'v1');
});

test('mutation: re-exporting rebindProcedure from the registry restores the unauthenticated bypass', () => {
  const assertion = (createRegistry) => {
    const registry = createRegistry();
    registry.createCapability({ workspaceId: 'ws', capabilityId: 'cap', boundProcedureVersion: 'v1' });
    // Whoever holds the registry must NOT be able to move the binding.
    if (typeof registry.rebindProcedure === 'function') {
      registry.rebindProcedure({ workspaceId: 'ws', capabilityId: 'cap', newProcedureVersion: 'v2' });
    }
    return registry.get('ws', 'cap').boundProcedureVersion;
  };
  assert.equal(assertion(require('../lib/experience/capability-trust').createCapabilityTrustRegistry), 'v1');
  const broken = mutant('lib/experience/capability-trust.js', '    createCapability,\r\n', '    createCapability,\r\n    rebindProcedure,\r\n');
  assert.equal(assertion(broken.createCapabilityTrustRegistry), 'v2');
});

test('unverifiable approver/admin identities are refused at record time', () => {
  const admissions = createPromotionAdmissionRegistry({ resolvePrincipal: HOST_RESOLVER });
  const approval = admissions.recordExplicitApproval({
    workspaceId: 'ws', capabilityId: 'cap', promotionId: 'p', approverId: 'ghost',
  });
  assert.equal(approval.ok, false);
  assert.equal(approval.code, 'unverified_approver');
  const toggle = admissions.setAutoPromoteToggle({
    workspaceId: 'ws', capabilityId: 'cap', adminId: 'ghost', enabled: true,
  });
  assert.equal(toggle.ok, false);
  assert.equal(toggle.code, 'unverified_admin');
  // Nothing was recorded, so nothing can be admitted later.
  const resolution = admissions.resolveAdmission({
    workspaceId: 'ws', capabilityId: 'cap', promotionId: 'p', proposerIds: ['learner'],
  });
  assert.equal(resolution.admitted, false);
});

test('a host-verified approver authorizes, and the admission is issued by the registry', () => {
  const admissions = createPromotionAdmissionRegistry({ resolvePrincipal: HOST_RESOLVER });
  const approval = admissions.recordExplicitApproval({
    workspaceId: 'ws', capabilityId: 'cap', promotionId: 'p', approverId: 'human-1',
  });
  assert.equal(approval.ok, true);
  const resolution = admissions.resolveAdmission({
    workspaceId: 'ws', capabilityId: 'cap', promotionId: 'p', proposerIds: ['learner'],
  });
  assert.equal(resolution.admitted, true);
  assert.equal(isIssuedAdmission(resolution), true);
});

test('mutation: removing the approver verification lets an unknown principal authorize', () => {
  const assertion = (moduleExports) => {
    const admissions = moduleExports.createPromotionAdmissionRegistry({ resolvePrincipal: HOST_RESOLVER });
    const approval = admissions.recordExplicitApproval({
      workspaceId: 'ws', capabilityId: 'cap', promotionId: 'p', approverId: 'ghost',
    });
    return approval.ok;
  };
  assert.equal(assertion(require('../lib/experience/canary-admission')), false);
  const broken = mutant('lib/experience/canary-admission.js',
    "      return { ok: false, code: 'unverified_approver' };", '      // verification removed');
  // With the guard gone the request succeeds — proving the guard was load-bearing.
  assert.equal(assertion(broken), true);
});

test('mutation: removing the admin verification lets an unknown principal enable auto-promotion', () => {
  const assertion = (moduleExports) => {
    const admissions = moduleExports.createPromotionAdmissionRegistry({ resolvePrincipal: HOST_RESOLVER });
    const toggle = admissions.setAutoPromoteToggle({
      workspaceId: 'ws', capabilityId: 'cap', adminId: 'ghost', enabled: true,
    });
    return toggle.ok && admissions.resolveAdmission({
      workspaceId: 'ws', capabilityId: 'cap', promotionId: 'p2', proposerIds: ['learner'],
    }).admitted;
  };
  assert.equal(assertion(require('../lib/experience/canary-admission')), false);
  const broken = mutant('lib/experience/canary-admission.js',
    "      return { ok: false, code: 'unverified_admin' };", '      // verification removed');
  assert.equal(assertion(broken), true);
});

test('the reflective loop refuses an empty learnerPrincipals list', () => {
  const trust = createCapabilityTrustRegistry();
  const admissions = createPromotionAdmissionRegistry({ resolvePrincipal: HOST_RESOLVER });
  assert.throws(
    () => require('../lib/experience/reflective-promotion').createReflectivePromotion({ trust, admissions }),
    TypeError,
  );
});

test('mutation: defaulting learnerPrincipals to empty re-opens self-authorization', () => {
  const { createReflectivePromotion } = require('../lib/experience/reflective-promotion');
  const trust = createCapabilityTrustRegistry();
  trust.createCapability({ workspaceId: 'ws', capabilityId: 'cap', boundProcedureVersion: 'v1' });
  const admissions = createPromotionAdmissionRegistry({ resolvePrincipal: HOST_RESOLVER });
  // The hard refusal is load-bearing: with the source default restored, a
  // loop built without principals must not throw (and a learner-approved
  // promotion would then go through unrefused).
  const broken = mutant('lib/experience/reflective-promotion.js',
    'if (!Array.isArray(learnerPrincipals) || learnerPrincipals.length === 0\r\n    || !learnerPrincipals.every(text)) {',
    'if (!Array.isArray(learnerPrincipals)) {');
  // With the emptiness check gone an EXPLICITLY EMPTY list is accepted —
  // exactly the hole #3552 closes.
  assert.doesNotThrow(() => broken.createReflectivePromotion({ trust, admissions, learnerPrincipals: [] }));
});
