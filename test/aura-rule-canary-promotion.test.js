'use strict';

// #3778 — a rule learned from an AURA signal must not reach `active` through the
// core activation path unless it carries a passing bounded canary trial. The
// AURA loop already refuses to promote without one; these tests pin the same
// condition on `activateRule`/`evaluateRuleAdmission`, so a plain call that
// skipped the trial cannot bypass the stricter path.

const test = require('node:test');
const assert = require('node:assert/strict');
const MemoryStore = require('../lib/memory-store');
const { createErrorPrevention } = require('../lib/error-prevention');
const { evaluateRuleAdmission } = require('../lib/error-prevention/admission');
const { auraRuleProvenance, isAuraDerivedProvenance } = require('../lib/error-prevention/rule-proposal');
const {
  auraRuleTrialEvidence,
  CANARY_STATUS,
} = require('../lib/aura-canary-bridge');

function makeEngine() {
  const memory = new MemoryStore({ useSQLite: false });
  const approvalSubjects = new Map();
  const prevention = createErrorPrevention(memory, {
    verifyEvidence({ source, evidence }) {
      return source === 'test_failure'
        && evidence.some((item) => item?.type === 'test' && item?.verifiedBy === 'ci');
    },
    resolveApproval({ approvalIdHint, rule, workspaceId, ruleSubjectHash }) {
      const status = approvalIdHint === 'approval-authoritative' ? 'approved' : 'pending';
      if (!approvalSubjects.has(approvalIdHint) && status !== 'pending') {
        approvalSubjects.set(approvalIdHint, {
          approvalId: approvalIdHint,
          ruleId: rule?.ruleId || '',
          workspaceId,
          ruleSubjectHash,
        });
      }
      const bound = approvalSubjects.get(approvalIdHint);
      return bound ? { ...bound, status } : {
        approvalId: approvalIdHint || '', status: 'pending', ruleId: '', workspaceId, ruleSubjectHash: '',
      };
    },
  });
  return { memory, prevention };
}

function recordFailure(prevention, provenance) {
  return prevention.recordFailure({
    source: 'test_failure', tool: 'edit', operation: 'modify_http_body_limit',
    workspaceId: 'huqan', repo: 'ali-ulu/huqan', path: 'server.js',
    expected: 'HTTP 413', observed: 'ECONNRESET',
    provenance,
    evidence: [{ type: 'test', ref: 'aura-rule-canary-promotion.test.js', verifiedBy: 'ci' }],
  });
}

test('the AURA provenance stamp is schema-valid and marks the rule as AURA-derived', () => {
  const provenance = auraRuleProvenance({ workspaceId: 'huqan' });
  assert.equal(isAuraDerivedProvenance(provenance), true);
  assert.equal(provenance.sourceRef, 'aura');
  // A plain memory provenance is not AURA-derived.
  assert.equal(isAuraDerivedProvenance({ sourceRef: 'axiom-memory-core' }), false);
});

test('auraRuleTrialEvidence admits only a passed, ok trial', () => {
  assert.deepEqual(auraRuleTrialEvidence({ ok: true, status: CANARY_STATUS.PASSED }), {
    ok: true, status: CANARY_STATUS.PASSED, reason: 'trial_passed',
  });
  assert.equal(auraRuleTrialEvidence({ ok: true, status: CANARY_STATUS.IN_TRIAL }).ok, false);
  assert.equal(auraRuleTrialEvidence({ ok: true, status: CANARY_STATUS.FAILED }).ok, false);
  assert.equal(auraRuleTrialEvidence(null).ok, false);
  assert.equal(auraRuleTrialEvidence(undefined).status, 'missing');
});

test('evaluateRuleAdmission rejects an AURA-derived rule with no passing trial', () => {
  const rule = { ruleId: 'rule-x', workspaceId: 'huqan', riskScore: 10, enforcement: 'warn' };
  const admission = evaluateRuleAdmission({
    ruleMemoryId: 'rule-memory-x',
    rule,
    provenance: auraRuleProvenance({ workspaceId: 'huqan' }),
    opts: { workspaceId: 'huqan' },
  });
  assert.equal(admission.ok, true);
  assert.equal(admission.decision.decision, 'reject');
  assert.equal(admission.decision.reason, 'aura_rule_requires_canary_trial');
  assert.equal(admission.decision.canaryTrialStatus, 'missing');
});

test('a passed trial clears the AURA gate, so the trial reason is never applied', () => {
  // The synthetic rule is too sparse for the downstream memory-admission schema,
  // so it does not reach `allow` here. The point under test is only that a passed
  // trial never produces the AURA refusal reason; the allow path is covered end
  // to end by the `activateRule` test below.
  const rule = { ruleId: 'rule-y', workspaceId: 'huqan', riskScore: 10, enforcement: 'warn' };
  const admission = evaluateRuleAdmission({
    ruleMemoryId: 'rule-memory-y',
    rule,
    provenance: auraRuleProvenance({ workspaceId: 'huqan' }),
    opts: { workspaceId: 'huqan', canaryTrial: { ok: true, status: CANARY_STATUS.PASSED } },
  });
  assert.notEqual(admission.decision?.reason, 'aura_rule_requires_canary_trial');
});

test('activateRule refuses an AURA rule with no trial and activates it once the trial passes', () => {
  const { prevention } = makeEngine();
  const failure = recordFailure(prevention, auraRuleProvenance({ workspaceId: 'huqan' }));
  assert.equal(failure.ok, true);
  const proposal = prevention.proposeRule(failure.memory.memoryId, {
    workspaceId: 'huqan',
    provenance: auraRuleProvenance({ workspaceId: 'huqan' }),
    enforcement: 'require_verify',
    constraint: 'Review the read when AURA signals fire.',
  });
  assert.equal(proposal.ok, true);
  assert.equal(isAuraDerivedProvenance(proposal.memory.provenance), true);

  // No trial evidence: the promotion is refused and the rule is terminated as
  // rejected, not left proposed. A re-preflight is fail-closed by construction.
  const refused = prevention.activateRule(proposal.memory.memoryId, { workspaceId: 'huqan' });
  assert.equal(refused.ok, false);
  assert.equal(refused.decision.decision, 'reject');
  assert.equal(refused.decision.canaryTrialStatus, 'missing');
  assert.equal(refused.memory.content.status, 'rejected');
  assert.equal(refused.memory.content.canaryTrialStatus, 'missing');

  // An in-trial (not passed) trial is equally refused.
  const inTrial = prevention.proposeRule(failure.memory.memoryId, {
    workspaceId: 'huqan',
    provenance: auraRuleProvenance({ workspaceId: 'huqan' }),
    enforcement: 'require_verify',
    constraint: 'Review the read when AURA signals fire.',
  });
  const refusedInTrial = prevention.activateRule(inTrial.memory.memoryId, {
    workspaceId: 'huqan',
    canaryTrial: { ok: true, status: CANARY_STATUS.IN_TRIAL },
  });
  assert.equal(refusedInTrial.ok, false);
  assert.equal(refusedInTrial.decision.canaryTrialStatus, CANARY_STATUS.IN_TRIAL);

  // With a passed trial AND an admission approval, the rule activates.
  const passing = prevention.proposeRule(failure.memory.memoryId, {
    workspaceId: 'huqan',
    provenance: auraRuleProvenance({ workspaceId: 'huqan' }),
    enforcement: 'require_verify',
    constraint: 'Review the read when AURA signals fire.',
  });
  const activated = prevention.activateRule(passing.memory.memoryId, {
    workspaceId: 'huqan',
    approvalId: 'approval-authoritative',
    canaryTrial: { ok: true, status: CANARY_STATUS.PASSED },
  });
  assert.equal(activated.ok, true);
  assert.equal(activated.rule.status, 'active');
  assert.equal(activated.rule.activationCanaryTrialStatus, CANARY_STATUS.PASSED);
});

test('a non-AURA rule is unaffected by the canary gate', () => {
  const { prevention } = makeEngine();
  const failure = recordFailure(prevention);
  assert.equal(failure.ok, true);
  const proposal = prevention.proposeRule(failure.memory.memoryId, {
    workspaceId: 'huqan',
    enforcement: 'require_verify',
    constraint: 'Review the read.',
  });
  assert.equal(isAuraDerivedProvenance(proposal.memory.provenance), false);
  const activated = prevention.activateRule(proposal.memory.memoryId, {
    workspaceId: 'huqan',
    approvalId: 'approval-authoritative',
  });
  assert.equal(activated.ok, true);
  assert.equal(activated.rule.status, 'active');
  assert.equal(activated.rule.activationCanaryTrialStatus, '');
});
