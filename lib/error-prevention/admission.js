'use strict';

const { evaluateMemoryAdmission } = require('../memory-admission-gate');

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function evaluateRuleAdmission({ ruleMemoryId, rule, memory, provenance, opts = {}, policyVersion, reason }) {
  const workspaceId = cleanString(opts.workspaceId || rule.workspaceId) || 'default';
  return evaluateMemoryAdmission({
    workspaceId,
    actor: cleanString(opts.actor) || 'error-prevention',
    agentId: cleanString(opts.agentId) || 'huqan',
    memoryDraftId: ruleMemoryId,
    proposedMemory: rule,
    provenanceId: cleanString(provenance?.provenanceId),
    trustPolicyVersion: cleanString(memory?.trustPolicyVersion) || policyVersion,
    approvalId: cleanString(opts.approvalId),
    approvalStatus: cleanString(opts.approvalStatus) || 'pending',
    approvalRequired: true,
    reason,
    riskScore: rule.enforcement === 'block' ? 40 : 20,
    createdAt: new Date().toISOString(),
  }, { approvalRequired: true });
}

module.exports = { evaluateRuleAdmission };
