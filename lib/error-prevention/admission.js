'use strict';

const { evaluateMemoryAdmission } = require('../memory-admission-gate');
const { isAuraDerivedProvenance } = require('./rule-proposal');

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// A rule derived from an AURA signal may only be promoted through the bounded
// canary trial (lib/experience/canary.js). Activation refuses it unless the
// caller carries evidence that the trial passed for that exact rule (#3778).
// This is the core-path counterpart of the AURA loop's promotionDecision: the
// loop already refuses to activate without a passing trial, and this stops the
// same rule being promoted by a plain activateRule call that skipped the trial.
function canaryTrialEvidence(opts = {}) {
  const trial = opts.canaryTrial || opts.trial;
  const admitted = trial?.status === 'passed' && trial?.ok === true;
  return { admitted, status: trial ? (trial.status || 'unknown') : 'missing' };
}

function ruleRiskScore(rule) {
  const score = Number(rule?.riskScore);
  if (Number.isFinite(score)) return Math.max(0, Math.min(100, Math.round(score)));
  return rule?.enforcement === 'block' ? 40 : 20;
}

// A hard refusal for an AURA-derived rule without a passing canary trial.
// Mirrors the memory-admission gate's result envelope (`ok`/`decision`/`receipt`)
// so `activateRule`'s existing terminal handling moves the rule to `rejected`
// and a re-preflight is fail-closed by construction.
function rejectedAuraTrial({ ruleMemoryId, rule, workspaceId, reason, policyVersion, memory }) {
  const riskScore = ruleRiskScore(rule);
  const decision = {
    decision: 'reject',
    reason: 'aura_rule_requires_canary_trial',
    canaryTrialStatus: reason,
    risk: { score: riskScore },
    workspaceId,
    memoryDraftId: ruleMemoryId,
    policyVersion,
    trustPolicyVersion: cleanString(memory?.trustPolicyVersion) || policyVersion,
  };
  return {
    ok: true,
    type: 'memory-admission-decision',
    warnings: [],
    errors: [],
    request: null,
    decision,
    receipt: null,
  };
}

function evaluateRuleAdmission({ ruleMemoryId, rule, memory, provenance, storedProvenance, ruleProvenance, approval = {}, opts = {}, policyVersion, reason }) {
  const workspaceId = cleanString(opts.workspaceId || rule.workspaceId) || 'default';

  // AURA-derived rules cannot skip the bounded canary trial. This runs before
  // the memory admission so the refusal is a hard `reject` with a stable reason
  // a caller can assert on, rather than a softer review state.
  const auraDerived = isAuraDerivedProvenance(provenance)
    || isAuraDerivedProvenance(storedProvenance)
    || isAuraDerivedProvenance(ruleProvenance)
    || isAuraDerivedProvenance(opts.storedProvenance)
    || isAuraDerivedProvenance(opts.ruleProvenance);
  if (auraDerived) {
    const trial = canaryTrialEvidence(opts);
    if (!trial.admitted) {
      return rejectedAuraTrial({ ruleMemoryId, rule, workspaceId, reason: trial.status, policyVersion, memory });
    }
  }

  return evaluateMemoryAdmission({
    workspaceId,
    actor: cleanString(opts.actor) || 'error-prevention',
    agentId: cleanString(opts.agentId) || 'huqan',
    memoryDraftId: ruleMemoryId,
    proposedMemory: rule,
    provenanceId: cleanString(provenance?.provenanceId),
    trustPolicyVersion: cleanString(memory?.trustPolicyVersion) || policyVersion,
    approvalId: cleanString(approval.approvalId),
    approvalStatus: cleanString(approval.status) || 'pending',
    approvalRequired: true,
    reason,
    riskScore: ruleRiskScore(rule),
    createdAt: new Date().toISOString(),
  }, { approvalRequired: true });
}

module.exports = { evaluateRuleAdmission, ruleRiskScore };
