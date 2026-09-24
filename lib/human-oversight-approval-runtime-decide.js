'use strict';

// #2148: an approver's decision on a review case. Identity comes from the
// receiver's resolver, never the request body; stale state, scope drift and
// unavailable durability fail closed.

const {
  HUMAN_OVERSIGHT_RUNTIME_VERSION,
  APPROVAL_DECISION_SCHEMA_VERSION,
  DECISION_TYPES,
  MAX_REASON,
  RUNTIME_REASONS,
  cloneJson,
  boundedText,
  safeMetadata,
  nowMillis,
  isoAt,
  parseInstant,
  makeId,
  freezeClone,
  fail,
  decisionOperationId,
  buildLedgerEvent,
} = require('./human-oversight-approval-runtime-primitives');

function createApprovalDecisions({ graph, clock, readResult, readCase, resolveRoleIdentity, appendState }) {
  function decide({ caseId, decisionType, approverContext, reason = '', validFrom, validUntil, evidenceDigest = '', decisionId = '', metadata = {} } = {}) {
    let normalizedCaseId;
    try {
      normalizedCaseId = boundedText(caseId, 'caseId', { required: true });
      decisionType = boundedText(decisionType, 'decisionType', { required: true }).toLowerCase();
      reason = boundedText(reason, 'reason', {
        required: decisionType !== 'approve' && decisionType !== 'expire' && decisionType !== 'override',
        max: MAX_REASON,
      });
      if (!DECISION_TYPES.includes(decisionType)) throw new TypeError('unsupported decisionType');
    } catch (error) {
      return fail(RUNTIME_REASONS.MALFORMED_DECISION, { message: error.message });
    }
    const currentRead = readCase(normalizedCaseId);
    if (!currentRead.ok) return currentRead;
    const current = currentRead.case;
    const reasonRequired = (decisionType === 'override' && current.firewallDecision === 'block')
      || (decisionType === 'approve' && current.riskScore >= current.policy.criticalRiskScore);
    if (reasonRequired && !reason) {
      return fail(RUNTIME_REASONS.DECISION_REASON_REQUIRED, {
        caseId: normalizedCaseId,
        decisionType,
        reasonRequired: true,
      });
    }
    const now = nowMillis(clock);
    if (now === null) return fail(RUNTIME_REASONS.DURABILITY_UNAVAILABLE, { reason: 'clock_unavailable' });
    if (current.expiryEffective || Date.parse(current.expiresAt) <= now) return fail(RUNTIME_REASONS.CASE_EXPIRED, { caseId: normalizedCaseId });

    const decisionScopeAction = {
      actionFingerprint: current.actionFingerprint,
      workspaceId: current.workspaceId,
      connectorRef: current.connectorRef,
      resourceRef: current.resourceRef,
      policyVersion: current.policyVersion,
      firewallVersion: current.firewallVersion,
      requestedVerdict: current.requestedVerdict,
      requestedEffect: current.requestedEffect,
      riskScore: current.riskScore,
      actionType: current.actionType,
      toolName: current.toolName,
      target: current.target,
      agentId: current.requester.agentId,
      evidenceRefs: current.evidenceRefs,
      provenanceRefs: current.provenanceRefs,
      evidenceDigest: current.evidenceDigest,
    };
    const approver = resolveRoleIdentity('approver', approverContext, decisionScopeAction);
    if (!approver.ok) return fail(approver.reason);
    const sameRequester = approver.identity.identityRef === current.requester.identityRef
      || approver.identity.identityHash === current.requester.identityHash;
    const selfApprovalException = sameRequester && current.policy.allowSelfApproval === true;
    if (sameRequester && current.policy.requireApproverDistinct && !selfApprovalException) {
      return fail(RUNTIME_REASONS.SELF_APPROVAL_REJECTED, { caseId: normalizedCaseId });
    }
    if (decisionType === 'override' && (!current.policy.allowOverride || current.firewallDecision !== 'block')) {
      return fail(RUNTIME_REASONS.OVERRIDE_NOT_AUTHORIZED, { caseId: normalizedCaseId });
    }
    if (decisionType === 'approve' && current.firewallDecision === 'block') {
      return fail(RUNTIME_REASONS.BLOCKED_BY_FIREWALL, { caseId: normalizedCaseId });
    }
    if (!['pending', 'escalated', 'blocked'].includes(current.status)
        || (current.status === 'blocked' && decisionType !== 'override')) {
      return fail(RUNTIME_REASONS.DUPLICATE_OR_AMBIGUOUS_DECISION, { caseId: normalizedCaseId, status: current.status });
    }
    if (decisionType === 'approve' && current.riskScore >= current.policy.criticalRiskScore) {
      let priorDecisions;
      try {
        priorDecisions = graph.getCommittedMutationResultsByPrefix('human-oversight:approval-decision:')
          .map((row) => row?.result?.decision)
          .filter((decision) => decision && decision.workspaceId === current.workspaceId);
      } catch (_) {
        return fail(RUNTIME_REASONS.DURABILITY_UNAVAILABLE, { caseId: normalizedCaseId });
      }
      const approverKey = `${approver.identity.identityRef}:${approver.identity.identityHash}`;
      const caseApprovers = new Set(priorDecisions
        .filter((decision) => decision.caseId === normalizedCaseId && ['approve', 'escalate'].includes(decision.decisionType))
        .map((decision) => `${decision.approver?.identityRef}:${decision.approver?.identityHash}`));
      if (caseApprovers.has(approverKey)) {
        return fail(RUNTIME_REASONS.QUORUM_DISTINCT_APPROVER_REQUIRED, { caseId: normalizedCaseId });
      }
      const previous = priorDecisions
        .filter((decision) => ['approve', 'escalate'].includes(decision.decisionType)
          && `${decision.approver?.identityRef}:${decision.approver?.identityHash}` === approverKey)
        .sort((left, right) => Date.parse(right.decidedAt) - Date.parse(left.decidedAt))[0];
      if (previous && now - Date.parse(previous.decidedAt) < current.policy.approvalCooldownMs) {
        return fail(RUNTIME_REASONS.APPROVAL_COOLDOWN_ACTIVE, { caseId: normalizedCaseId });
      }
      caseApprovers.add(approverKey);
      if (caseApprovers.size < current.policy.requiredApprovers) {
        decisionType = 'escalate';
      }
    }

    let interval;
    try {
      interval = {
        validFrom: validFrom ? parseInstant(validFrom, 'validFrom').text : isoAt(now),
        validUntil: validUntil ? parseInstant(validUntil, 'validUntil').text : current.expiresAt,
      };
    } catch (error) {
      return fail(RUNTIME_REASONS.MALFORMED_DECISION, { message: error.message });
    }
    if (Date.parse(interval.validFrom) < now || Date.parse(interval.validUntil) <= now
        || Date.parse(interval.validFrom) >= Date.parse(interval.validUntil)
        || Date.parse(interval.validUntil) > Date.parse(current.expiresAt)) {
      return fail(RUNTIME_REASONS.SCOPE_MISMATCH, { reason: 'validity_interval_invalid' });
    }
    const boundedEvidenceDigest = boundedText(evidenceDigest || current.evidenceDigest, 'evidenceDigest', { required: true });
    if (boundedEvidenceDigest !== current.evidenceDigest) return fail(RUNTIME_REASONS.SCOPE_MISMATCH, { reason: 'evidence_digest_mismatch' });
    const resolvedDecisionId = boundedText(decisionId, 'decisionId') || makeId('approval-decision', {
      caseId: normalizedCaseId,
      decisionType,
      approverIdentityRef: approver.identity.identityRef,
      approverIdentityHash: approver.identity.identityHash,
      reason,
      validFrom: interval.validFrom,
      validUntil: interval.validUntil,
      evidenceDigest: boundedEvidenceDigest,
    });
    const operationId = decisionOperationId(normalizedCaseId, resolvedDecisionId);
    const replay = readResult(operationId);
    if (replay?.status === 'completed' && replay.result?.decision) {
      return Object.freeze({ ok: true, replayed: true, case: freezeClone(replay.result.case), decision: freezeClone(replay.result.decision), receipt: replay.receipt || null, verification: null });
    }

    const nextStatus = decisionType === 'approve' || decisionType === 'override' ? 'approved'
      : decisionType === 'reject' ? 'rejected'
        : decisionType === 'expire' ? 'expired'
          : decisionType === 'cancel' ? 'cancelled'
            : 'escalated';
    const decision = {
      schemaVersion: APPROVAL_DECISION_SCHEMA_VERSION,
      runtimeVersion: HUMAN_OVERSIGHT_RUNTIME_VERSION,
      decisionId: resolvedDecisionId,
      decisionType,
      caseId: normalizedCaseId,
      workspaceId: current.workspaceId,
      approver: {
        identityRef: approver.identity.identityRef,
        identityHash: approver.identity.identityHash,
        ownerActorId: approver.identity.ownerActorId,
        authorityRef: approver.identity.authorityRef,
      },
      requesterIdentityRef: current.requester.identityRef,
      actionFingerprint: current.actionFingerprint,
      connectorRef: current.connectorRef,
      resourceRef: current.resourceRef,
      policyVersion: current.policyVersion,
      firewallVersion: current.firewallVersion,
      evidenceDigest: boundedEvidenceDigest,
      reason,
      validFrom: interval.validFrom,
      validUntil: interval.validUntil,
      decidedAt: isoAt(now),
      selfApprovalException,
      metadata: safeMetadata(metadata),
      receiptId: '',
    };
    const nextCase = {
      ...cloneJson(current, 'case'),
      status: nextStatus,
      latestDecisionId: resolvedDecisionId,
      latestDecisionType: decisionType,
      executionOutcome: nextStatus === 'approved' ? 'not_attempted' : current.executionOutcome,
      expiryEffective: false,
    };
    const eventType = decisionType === 'approve' ? 'approval_approved'
      : decisionType === 'reject' ? 'approval_rejected'
        : decisionType === 'expire' ? 'approval_expired'
          : decisionType === 'cancel' ? 'approval_cancelled'
            : decisionType === 'escalate' ? 'approval_escalated'
              : 'approval_override';
    const event = buildLedgerEvent({
      workspaceId: current.workspaceId,
      operationId,
      caseRecord: current,
      eventType,
      decisionType,
      reason,
      createdAt: decision.decidedAt,
      metadata: {
        decisionId: resolvedDecisionId,
        evidenceDigest: boundedEvidenceDigest,
        verifiedFields: ['caseId', 'actionFingerprint', 'workspaceId', 'connectorRef', 'resourceRef', 'policyVersion', 'firewallVersion', 'evidenceDigest'],
        requestedFields: ['reason'],
        unverifiedFields: [],
        selfApprovalException,
        approverIdentityRef: approver.identity.identityRef,
        approverIdentityHash: approver.identity.identityHash,
        approverAuthorityRef: approver.identity.authorityRef,
        requesterIdentityRef: current.requester.identityRef,
        requesterIdentityHash: current.requester.identityHash,
      },
    });
    try {
      const appended = appendState({ operationId, event, nextCase, decision });
      return Object.freeze({ ok: true, replayed: appended.replayed, case: freezeClone(appended.state.case), decision: freezeClone(appended.state.decision), receipt: appended.receipt, verification: appended.verification });
    } catch (error) {
      return fail(RUNTIME_REASONS.DURABILITY_UNAVAILABLE, { caseId: normalizedCaseId, message: error.message });
    }
  }

  return { decide };
}
module.exports = { createApprovalDecisions };
