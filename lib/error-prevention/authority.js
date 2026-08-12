'use strict';

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function verifyFailureEvidence(verifier, source, evidence, input) {
  if (typeof verifier !== 'function') return { verified: false, reason: 'verifier_unavailable' };
  try {
    const result = verifier({ source, evidence: clone(evidence), input: clone(input) });
    if (result === true) return { verified: true, reason: 'verified_by_authority' };
    if (result && typeof result === 'object') {
      return { verified: result.verified === true, reason: cleanString(result.reason) || 'verifier_decision' };
    }
    return { verified: false, reason: 'verifier_rejected' };
  } catch (_) {
    return { verified: false, reason: 'verifier_error' };
  }
}

function resolveRuleApproval(resolver, ruleMemoryId, rule, opts = {}) {
  const workspaceId = cleanString(opts.workspaceId || rule?.workspaceId) || 'default';
  const approvalIdHint = cleanString(opts.approvalId);
  if (typeof resolver !== 'function') return { approvalId: approvalIdHint, status: 'pending' };
  try {
    const result = resolver({ ruleMemoryId, rule: clone(rule), workspaceId, approvalIdHint });
    const approvalId = cleanString(result?.approvalId);
    const status = cleanString(result?.status).toLowerCase();
    const boundRuleId = cleanString(result?.ruleId);
    const boundWorkspaceId = cleanString(result?.workspaceId);
    const authoritative = ['approved', 'rejected', 'cancelled', 'expired'];
    const bindingMatches = approvalId && approvalId === approvalIdHint
      && boundRuleId === cleanString(rule?.ruleId)
      && boundWorkspaceId === workspaceId;
    if (!bindingMatches || !authoritative.includes(status)) return { approvalId, status: 'pending' };
    return { approvalId, status, ruleId: boundRuleId, workspaceId: boundWorkspaceId };
  } catch (_) {
    return { approvalId: approvalIdHint, status: 'pending' };
  }
}

module.exports = { resolveRuleApproval, verifyFailureEvidence };
