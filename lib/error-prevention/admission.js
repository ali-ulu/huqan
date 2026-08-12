'use strict';

const { evaluateMemoryAdmission } = require('../memory-admission-gate');

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function ruleRiskScore(rule) {
  const score = Number(rule?.riskScore);
  if (Number.isFinite(score)) return Math.max(0, Math.min(100, Math.round(score)));
  return rule?.enforcement === 'block' ? 40 : 20;
}

function evaluateRuleAdmission({ ruleMemoryId, rule, memory, provenance, approval = {}, opts = {}, policyVersion, reason }) {
  const workspaceId = cleanString(opts.workspaceId || rule.workspaceId) || 'default';
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
