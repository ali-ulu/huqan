'use strict';

const { buildRuleSubjectHash } = require('./subject');

function finding(rule, reason, failureId = '') {
  return { ruleId: rule?.ruleId || '', failureId, trigger: rule?.trigger || {}, reason };
}

function inspectActiveRuleIntegrity(store, rules, workspaceId, authorities = {}) {
  const trustedRules = [];
  const findings = [];

  for (const rule of Array.isArray(rules) ? rules : []) {
    const failureResult = store.get(rule.sourceFailureMemoryId, workspaceId);
    if (!failureResult.ok || failureResult.memory?.content?.kind !== 'failure_record') {
      findings.push(finding(rule, 'SOURCE_FAILURE_MISSING'));
      continue;
    }

    const failure = failureResult.memory.content;
    const evidenceDecision = authorities.verifyFailure ? authorities.verifyFailure(failure) : { verified: false };
    if (!evidenceDecision?.verified) {
      findings.push(finding(rule, 'SOURCE_EVIDENCE_UNVERIFIED', failure.failureId));
      continue;
    }

    if (!rule.activationApprovalId) {
      findings.push(finding(rule, 'ACTIVATION_APPROVAL_MISSING', failure.failureId));
      continue;
    }

    const currentSubjectHash = buildRuleSubjectHash(rule);
    if (!rule.activationSubjectHash || rule.activationSubjectHash !== currentSubjectHash) {
      findings.push(finding(rule, 'RULE_SUBJECT_HASH_MISMATCH', failure.failureId));
      continue;
    }

    const approval = authorities.resolveApproval
      ? authorities.resolveApproval(rule.memoryId, rule, rule.activationApprovalId)
      : { status: 'pending' };
    if (approval?.status !== 'approved' || approval.ruleSubjectHash !== currentSubjectHash) {
      findings.push(finding(rule, 'ACTIVATION_APPROVAL_UNVERIFIED', failure.failureId));
      continue;
    }

    trustedRules.push(rule);
  }

  return { trustedRules, findings };
}

module.exports = { inspectActiveRuleIntegrity };
