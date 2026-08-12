'use strict';

function inspectActiveRuleIntegrity(store, rules, workspaceId, authorities = {}) {
  const trustedRules = [];
  const findings = [];

  for (const rule of Array.isArray(rules) ? rules : []) {
    const failureResult = store.get(rule.sourceFailureMemoryId, workspaceId);
    if (!failureResult.ok || failureResult.memory?.content?.kind !== 'failure_record') {
      findings.push({ ruleId: rule.ruleId, reason: 'SOURCE_FAILURE_MISSING' });
      continue;
    }

    const failure = failureResult.memory.content;
    const evidenceDecision = authorities.verifyFailure ? authorities.verifyFailure(failure) : { verified: false };
    if (!evidenceDecision?.verified) {
      findings.push({ ruleId: rule.ruleId, failureId: failure.failureId, reason: 'SOURCE_EVIDENCE_UNVERIFIED' });
      continue;
    }

    if (!rule.activationApprovalId) {
      findings.push({ ruleId: rule.ruleId, failureId: failure.failureId, reason: 'ACTIVATION_APPROVAL_MISSING' });
      continue;
    }

    const approval = authorities.resolveApproval
      ? authorities.resolveApproval(rule.memoryId, rule, rule.activationApprovalId)
      : { status: 'pending' };
    if (approval?.status !== 'approved') {
      findings.push({ ruleId: rule.ruleId, failureId: failure.failureId, reason: 'ACTIVATION_APPROVAL_UNVERIFIED' });
      continue;
    }

    trustedRules.push(rule);
  }

  return { trustedRules, findings };
}

module.exports = { inspectActiveRuleIntegrity };
