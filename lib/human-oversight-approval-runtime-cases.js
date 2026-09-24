'use strict';

// #2148: opening a review case from a firewall review decision, and the
// read-only evidence view of an existing case.

const {
  HUMAN_OVERSIGHT_RUNTIME_VERSION,
  REVIEW_CASE_SCHEMA_VERSION,
  MAX_CASE_LIFETIME_MS,
  RUNTIME_REASONS,
  boundedText,
  nowMillis,
  isoAt,
  parseInstant,
  makeId,
  freezeClone,
  fail,
  validFirewallDecision,
  normalizeAction,
  normalizePolicy,
  caseOperationId,
  buildLedgerEvent,
} = require('./human-oversight-approval-runtime-primitives');

function createApprovalCases({ clock, lifetime, readResult, resolveRoleIdentity, appendState }) {
  function createReviewCase({
    action,
    firewallDecision,
    requesterContext,
    policy = {},
    expiresAt,
    caseId = '',
    metadata = {},
  } = {}) {
    let normalizedAction;
    try {
      normalizedAction = normalizeAction({ ...action, requestedVerdict: action?.requestedVerdict || firewallDecision });
      if (normalizedAction.requestedVerdict !== firewallDecision) throw new TypeError('firewall decision mismatch');
      if (!validFirewallDecision(firewallDecision)) throw new TypeError('firewallDecision is invalid');
    } catch (error) {
      return fail(RUNTIME_REASONS.MALFORMED_CASE, { message: error.message });
    }
    const now = nowMillis(clock);
    if (now === null) return fail(RUNTIME_REASONS.DURABILITY_UNAVAILABLE, { reason: 'clock_unavailable' });
    let expiry;
    try {
      expiry = expiresAt === undefined || expiresAt === null || expiresAt === ''
        ? { text: isoAt(now + lifetime), time: now + lifetime }
        : parseInstant(expiresAt, 'expiresAt');
    } catch (error) {
      return fail(RUNTIME_REASONS.MALFORMED_CASE, { message: error.message });
    }
    if (expiry.time <= now || expiry.time - now > MAX_CASE_LIFETIME_MS) {
      return fail(RUNTIME_REASONS.MALFORMED_CASE, { reason: 'expiry_out_of_bounds' });
    }
    const normalizedPolicy = normalizePolicy(policy);
    const requester = resolveRoleIdentity('requester', requesterContext, normalizedAction);
    if (!requester.ok) return fail(requester.reason);
    const resolvedCaseId = boundedText(caseId, 'caseId') || makeId('review-case', {
      workspaceId: normalizedAction.workspaceId,
      requesterIdentityRef: requester.identity.identityRef,
      requesterIdentityHash: requester.identity.identityHash,
      actionFingerprint: normalizedAction.actionFingerprint,
      connectorRef: normalizedAction.connectorRef,
      resourceRef: normalizedAction.resourceRef,
      policyVersion: normalizedAction.policyVersion,
      firewallVersion: normalizedAction.firewallVersion,
    });
    const operationId = caseOperationId(resolvedCaseId);
    const existing = readResult(operationId);
    if (existing?.status === 'completed' && existing.result?.case) {
      const stored = existing.result.case;
      const immutableMatch = stored.actionFingerprint === normalizedAction.actionFingerprint
        && stored.workspaceId === normalizedAction.workspaceId
        && stored.requester?.identityRef === requester.identity.identityRef
        && stored.requester?.identityHash === requester.identity.identityHash
        && stored.connectorRef === normalizedAction.connectorRef
        && stored.resourceRef === normalizedAction.resourceRef
        && stored.policyVersion === normalizedAction.policyVersion
        && stored.firewallVersion === normalizedAction.firewallVersion
        && stored.requestedVerdict === normalizedAction.requestedVerdict
        && stored.requestedEffect === normalizedAction.requestedEffect
        && stored.riskScore === normalizedAction.riskScore
        && stored.evidenceDigest === normalizedAction.evidenceDigest;
      if (!immutableMatch) return fail(RUNTIME_REASONS.CASE_IMMUTABLE_MISMATCH, { caseId: resolvedCaseId });
      return Object.freeze({ ok: true, replayed: true, case: freezeClone(stored), receipt: existing.receipt || null, verification: null });
    }

    const caseRecord = {
      schemaVersion: REVIEW_CASE_SCHEMA_VERSION,
      runtimeVersion: HUMAN_OVERSIGHT_RUNTIME_VERSION,
      caseId: resolvedCaseId,
      workspaceId: normalizedAction.workspaceId,
      requester: {
        identityRef: requester.identity.identityRef,
        identityHash: requester.identity.identityHash,
        agentId: requester.identity.agentId || normalizedAction.agentId,
        ownerActorId: requester.identity.ownerActorId,
        authorityRef: requester.identity.authorityRef,
        delegationRef: boundedText(requesterContext?.delegationRef, 'delegationRef'),
      },
      connectorRef: normalizedAction.connectorRef,
      resourceRef: normalizedAction.resourceRef,
      actionFingerprint: normalizedAction.actionFingerprint,
      actionType: normalizedAction.actionType,
      toolName: normalizedAction.toolName,
      target: normalizedAction.target,
      requestedVerdict: normalizedAction.requestedVerdict,
      firewallDecision,
      policyVersion: normalizedAction.policyVersion,
      firewallVersion: normalizedAction.firewallVersion,
      requestedEffect: normalizedAction.requestedEffect,
      riskScore: normalizedAction.riskScore,
      evidenceRefs: normalizedAction.evidenceRefs,
      provenanceRefs: normalizedAction.provenanceRefs,
      evidenceDigest: normalizedAction.evidenceDigest,
      policy: normalizedPolicy,
      createdAt: isoAt(now),
      expiresAt: expiry.text,
      status: firewallDecision === 'block' ? 'blocked' : 'pending',
      latestDecisionId: '',
      latestDecisionType: '',
      latestReceiptId: '',
      executionOutcome: 'not_attempted',
    };
    const event = buildLedgerEvent({
      workspaceId: caseRecord.workspaceId,
      operationId,
      caseRecord,
      eventType: 'review_case_created',
      decisionType: firewallDecision,
      reason: firewallDecision === 'block' ? 'firewall_blocked_review_case_recorded' : 'human_review_required',
      createdAt: caseRecord.createdAt,
      metadata: {
        evidenceDigest: caseRecord.evidenceDigest,
        verifiedFields: ['workspaceId', 'actionFingerprint', 'policyVersion', 'firewallVersion'],
        requestedFields: ['requestedEffect'],
        unverifiedFields: ['model_risk_claims'],
        metadata,
      },
    });
    try {
      const appended = appendState({ operationId, event, nextCase: caseRecord });
      return Object.freeze({ ok: true, replayed: appended.replayed, case: freezeClone(appended.state.case), receipt: appended.receipt, verification: appended.verification });
    } catch (error) {
      return fail(RUNTIME_REASONS.DURABILITY_UNAVAILABLE, { caseId: resolvedCaseId, message: error.message });
    }
  }

  function buildEvidenceView(caseState) {
    if (!caseState?.ok) return caseState;
    const record = caseState.case;
    return Object.freeze({
      ok: true,
      caseId: record.caseId,
      requested: Object.freeze({ requestedEffect: record.requestedEffect, requestedVerdict: record.requestedVerdict }),
      verified: Object.freeze({
        workspaceId: record.workspaceId,
        actionFingerprint: record.actionFingerprint,
        connectorRef: record.connectorRef,
        resourceRef: record.resourceRef,
        policyVersion: record.policyVersion,
        firewallVersion: record.firewallVersion,
        evidenceDigest: record.evidenceDigest,
      }),
      observed: Object.freeze({ firewallDecision: record.firewallDecision, status: record.status, expiresAt: record.expiresAt, latestReceiptId: record.latestReceiptId }),
      provenanceRefs: Object.freeze([...record.provenanceRefs]),
      evidenceRefs: Object.freeze([...record.evidenceRefs]),
      unverified: Object.freeze(['model_risk_claims']),
      knownLimitations: Object.freeze(['Approval is not connector authorization.', 'The action executor must still enforce its own authorization boundary.']),
    });
  }

  return { createReviewCase, buildEvidenceView };
}
module.exports = { createApprovalCases };
