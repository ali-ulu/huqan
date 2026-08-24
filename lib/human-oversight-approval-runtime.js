'use strict';

/**
 * Human Oversight & Approval Runtime — #942 first runtime slice.
 *
 * This module is deliberately bounded. It does not implement a workflow suite,
 * IAM provider, connector authorization system, or a second storage authority.
 * Review cases and immutable transition snapshots are committed through the
 * existing Graph mutation journal and Trust Evidence Ledger.
 *
 * The runtime never accepts an approver identity from the decision body. The
 * receiver/operator supplies an authenticated context and the injected identity
 * resolver turns that context into a receiver-owned identity result. Missing or
 * ambiguous identity, stale state, scope drift, unavailable durability, and
 * firewall disagreement all fail closed.
 */

const {
  HUMAN_OVERSIGHT_RUNTIME_VERSION,
  REVIEW_CASE_SCHEMA_VERSION,
  APPROVAL_DECISION_SCHEMA_VERSION,
  STATE_RECORD_SCHEMA_VERSION,
  DECISION_TYPES,
  CASE_STATUSES,
  EXECUTION_OUTCOMES,
  MAX_REASON,
  MAX_HISTORY,
  DEFAULT_CASE_LIFETIME_MS,
  MAX_CASE_LIFETIME_MS,
  RUNTIME_REASONS,
  isPlainObject,
  cloneJson,
  boundedText,
  boundedRefs,
  safeMetadata,
  nowMillis,
  isoAt,
  parseInstant,
  hashObject,
  makeId,
  freezeClone,
  fail,
  validFirewallDecision,
  normalizeIdentity,
  normalizeAction,
  normalizePolicy,
  caseOperationId,
  decisionOperationPrefix,
  decisionOperationId,
  outcomeOperationId,
  buildLedgerEvent,
  AGENT_ACTION_FIREWALL_DECISIONS,
  evaluateAgentActionFirewall,
  TRUST_EVIDENCE_SCHEMA_VERSION,
  buildTrustEvidencePayload,
} = require('./human-oversight-approval-runtime-primitives');

function createHumanOversightApprovalRuntime({
  graph,
  ledger,
  resolveIdentity,
  firewallEvaluator = evaluateAgentActionFirewall,
  clock = () => Date.now(),
  maxCaseLifetimeMs = DEFAULT_CASE_LIFETIME_MS,
} = {}) {
  if (!graph || typeof graph.runMutationOnce !== 'function') {
    throw new Error('graph with runMutationOnce is required');
  }
  if (!ledger || typeof ledger.append !== 'function') {
    throw new Error('trust evidence ledger is required');
  }
  if (typeof graph.getCommittedMutationResultByOperation !== 'function'
      || typeof graph.getCommittedMutationResultsByPrefix !== 'function') {
    throw new Error('graph mutation result read APIs are required');
  }
  if (typeof resolveIdentity !== 'function') {
    throw new Error('receiver-owned identity resolver is required');
  }
  if (typeof firewallEvaluator !== 'function') {
    throw new Error('firewall evaluator is required');
  }

  const lifetime = Math.max(1_000, Math.min(MAX_CASE_LIFETIME_MS, Number(maxCaseLifetimeMs) || DEFAULT_CASE_LIFETIME_MS));

  function readResult(operationId) {
    try {
      return graph.getCommittedMutationResultByOperation(operationId);
    } catch (_) {
      return null;
    }
  }

  function readCase(caseId) {
    let normalizedCaseId;
    try { normalizedCaseId = boundedText(caseId, 'caseId', { required: true }); } catch (_) { return fail(RUNTIME_REASONS.MALFORMED_CASE); }
    const base = readResult(caseOperationId(normalizedCaseId));
    if (!base || base.status !== 'completed' || !base.result || base.result.kind !== 'human_oversight_state') {
      return fail(RUNTIME_REASONS.CASE_NOT_FOUND, { caseId: normalizedCaseId });
    }
    let current = base.result.case;
    const events = [];
    try {
      const prefixes = [decisionOperationPrefix(normalizedCaseId), `human-oversight:execution-outcome:${normalizedCaseId}:`];
      for (const prefix of prefixes) {
        const rows = graph.getCommittedMutationResultsByPrefix(prefix);
        for (const row of Array.isArray(rows) ? rows : []) {
          if (row?.result?.kind !== 'human_oversight_state' || row.result.case?.caseId !== normalizedCaseId) continue;
          events.push(row);
        }
      }
    } catch (_) {
      return fail(RUNTIME_REASONS.DURABILITY_UNAVAILABLE, { caseId: normalizedCaseId });
    }
    events.sort((left, right) => String(left.committedAt || '').localeCompare(String(right.committedAt || '')));
    if (events.length > MAX_HISTORY) return fail(RUNTIME_REASONS.DURABILITY_UNAVAILABLE, { caseId: normalizedCaseId, reason: 'history_bound_exceeded' });
    for (const row of events) current = row.result.case;
    const currentTime = nowMillis(clock);
    if (currentTime === null) return fail(RUNTIME_REASONS.DURABILITY_UNAVAILABLE, { caseId: normalizedCaseId, reason: 'clock_unavailable' });
    const effective = cloneJson(current, 'case');
    if (['pending', 'escalated'].includes(effective.status) && Date.parse(effective.expiresAt) <= currentTime) {
      effective.status = 'expired';
      effective.expiryEffective = true;
    }
    return Object.freeze({ ok: true, case: freezeClone(effective), history: freezeClone(events.map(row => row.result.event).filter(Boolean)), baseResult: base.result });
  }

  function resolveRoleIdentity(role, context, action) {
    let result;
    try {
      result = resolveIdentity({ role, context, action: cloneJson(action, 'identity action') });
    } catch (_) {
      return { ok: false, reason: RUNTIME_REASONS.RESOLVER_FAILED };
    }
    return normalizeIdentity(result, role, action.workspaceId);
  }

  function appendState({ operationId, event, nextCase, decision = null, execution = null }) {
    const payload = buildTrustEvidencePayload(event);
    const state = {
      schemaVersion: STATE_RECORD_SCHEMA_VERSION,
      kind: 'human_oversight_state',
      event: {
        eventType: event.metadata.eventType,
        decisionType: event.metadata.decisionType,
        caseId: nextCase.caseId,
        createdAt: event.createdAt,
        reason: event.reason,
      },
      case: nextCase,
      decision,
      execution,
    };
    if (event.metadata.eventType === 'review_case_created') {
      state.case.creationReceiptId = payload.receiptId;
    } else if (decision) {
      state.decision.receiptId = payload.receiptId;
      state.case.latestReceiptId = payload.receiptId;
    } else if (execution) {
      state.execution.receiptId = payload.receiptId;
      state.case.latestReceiptId = payload.receiptId;
    }
    const appended = ledger.append({
      operationId,
      event,
      mutate: () => cloneJson(state, 'approval state'),
    });
    return {
      replayed: Boolean(appended.replayed),
      state: appended.result,
      receipt: appended.receipt,
      verification: appended.verification,
    };
  }

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
    const reasonRequired = decisionType === 'override' && current.firewallDecision === 'block';
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

  function authorizeExecution({ caseId, action, requesterContext, firewallRequest = {}, allowDryRun = false } = {}) {
    const currentRead = readCase(caseId);
    if (!currentRead.ok) return currentRead;
    const current = currentRead.case;
    const now = nowMillis(clock);
    if (now === null) return fail(RUNTIME_REASONS.DURABILITY_UNAVAILABLE, { reason: 'clock_unavailable' });
    if (current.expiryEffective || Date.parse(current.expiresAt) <= now) return fail(RUNTIME_REASONS.CASE_EXPIRED, { caseId });
    if (!['approved'].includes(current.status)) return fail(RUNTIME_REASONS.APPROVAL_REQUIRED, { caseId, status: current.status });
    if (!current.latestDecisionType || !['approve', 'override'].includes(current.latestDecisionType)) {
      return fail(RUNTIME_REASONS.APPROVAL_REQUIRED, { caseId });
    }
    let normalizedAction;
    try { normalizedAction = normalizeAction({ ...action, requestedVerdict: action?.requestedVerdict || current.requestedVerdict }); } catch (error) {
      return fail(RUNTIME_REASONS.ACTION_MISMATCH, { message: error.message });
    }
    const fields = ['workspaceId', 'connectorRef', 'resourceRef', 'actionFingerprint', 'policyVersion', 'firewallVersion', 'requestedVerdict'];
    if (fields.some(field => normalizedAction[field] !== current[field])) return fail(RUNTIME_REASONS.SCOPE_MISMATCH, { caseId });
    const requester = resolveRoleIdentity('requester', requesterContext, normalizedAction);
    if (!requester.ok) return fail(requester.reason);
    if (requester.identity.identityRef !== current.requester.identityRef || requester.identity.identityHash !== current.requester.identityHash) {
      return fail(RUNTIME_REASONS.REQUESTER_IDENTITY_REQUIRED, { caseId });
    }
    if (current.requestedVerdict === 'dry_run_only' && !allowDryRun) return fail(RUNTIME_REASONS.DRY_RUN_EXECUTOR_BLOCKED, { caseId });

    const approvalResult = current.latestDecisionId
      ? readResult(decisionOperationId(current.caseId, current.latestDecisionId))
      : null;
    const approval = approvalResult?.result?.decision;
    if (!approval || !['approve', 'override'].includes(approval.decisionType)
        || approval.caseId !== current.caseId
        || approval.actionFingerprint !== current.actionFingerprint
        || approval.workspaceId !== current.workspaceId
        || approval.connectorRef !== current.connectorRef
        || approval.resourceRef !== current.resourceRef
        || approval.policyVersion !== current.policyVersion
        || approval.firewallVersion !== current.firewallVersion
        || approval.evidenceDigest !== current.evidenceDigest) {
      return fail(RUNTIME_REASONS.APPROVAL_REQUIRED, { caseId, reason: 'approval_record_missing_or_mismatched' });
    }
    const approvalValidFrom = Date.parse(approval.validFrom);
    const approvalValidUntil = Date.parse(approval.validUntil);
    if (!Number.isFinite(approvalValidFrom) || !Number.isFinite(approvalValidUntil)
        || approvalValidFrom > now || approvalValidUntil <= now || approvalValidUntil > Date.parse(current.expiresAt)) {
      return fail(RUNTIME_REASONS.CASE_EXPIRED, { caseId, reason: 'approval_interval_invalid' });
    }

    let firewallDecision;
    try {
      firewallDecision = firewallEvaluator({
        ...cloneJson(firewallRequest, 'firewallRequest'),
        surface: 'human-oversight-execution',
        tool: normalizedAction.toolName,
        action: normalizedAction.actionType,
        input: {
          action: normalizedAction.actionType,
          operationType: normalizedAction.actionType,
          target: normalizedAction.target || normalizedAction.resourceRef,
        },
        context: {
          ...(isPlainObject(firewallRequest.context) ? firewallRequest.context : {}),
          workspaceId: current.workspaceId,
          actor: `agent:${current.requester.agentId || current.requester.identityRef}`,
        },
        approval: { explicit: true, approved: true, reviewed: true, reviewedBy: current.latestDecisionId },
      });
    } catch (_) {
      return fail(RUNTIME_REASONS.FIREWALL_EVALUATION_FAILED, { caseId });
    }
    if (!firewallDecision || firewallDecision.decision !== AGENT_ACTION_FIREWALL_DECISIONS.ALLOW) {
      return fail(firewallDecision?.decision === 'block' ? RUNTIME_REASONS.BLOCKED_BY_FIREWALL : RUNTIME_REASONS.FIREWALL_MISMATCH, { caseId, firewallDecision: firewallDecision?.decision || '' });
    }
    if (firewallDecision.metadata?.firewallVersion && firewallDecision.metadata.firewallVersion !== current.firewallVersion) {
      return fail(RUNTIME_REASONS.FIREWALL_MISMATCH, { caseId });
    }
    return Object.freeze({ ok: true, allowed: true, case: freezeClone(current), approval: freezeClone(approval), firewallDecision: freezeClone(firewallDecision), requester: freezeClone(requester.identity) });
  }

  function recordExecutionOutcome({ caseId, outcomeId = '', outcome, reason = '', metadata = {} } = {}) {
    const currentRead = readCase(caseId);
    if (!currentRead.ok) return currentRead;
    const current = currentRead.case;
    const now = nowMillis(clock);
    if (now === null) return fail(RUNTIME_REASONS.DURABILITY_UNAVAILABLE, { reason: 'clock_unavailable' });
    if (!['approved', 'executed', 'reconciliation_required'].includes(current.status)) return fail(RUNTIME_REASONS.APPROVAL_REQUIRED, { caseId });
    if (!EXECUTION_OUTCOMES.includes(outcome)) return fail(RUNTIME_REASONS.MALFORMED_DECISION, { reason: 'invalid_execution_outcome' });
    const resolvedOutcomeId = boundedText(outcomeId, 'outcomeId') || makeId('execution-outcome', { caseId, outcome, reason });
    const operationId = outcomeOperationId(caseId, resolvedOutcomeId);
    const replay = readResult(operationId);
    if (replay?.status === 'completed' && replay.result?.execution) return Object.freeze({ ok: true, replayed: true, case: freezeClone(replay.result.case), execution: freezeClone(replay.result.execution), receipt: replay.receipt || null, verification: null });
    const execution = {
      schemaVersion: APPROVAL_DECISION_SCHEMA_VERSION,
      caseId: current.caseId,
      outcomeId: resolvedOutcomeId,
      outcome,
      reason: boundedText(reason, 'reason', { max: MAX_REASON }),
      observedAt: isoAt(now),
      metadata: safeMetadata(metadata),
      receiptId: '',
    };
    const nextCase = {
      ...cloneJson(current, 'case'),
      status: outcome === 'succeeded' ? 'executed' : outcome === 'unknown' ? 'reconciliation_required' : 'approved',
      executionOutcome: outcome,
      latestReceiptId: '',
    };
    const event = buildLedgerEvent({
      workspaceId: current.workspaceId,
      operationId,
      caseRecord: current,
      eventType: 'execution_outcome',
      decisionType: 'approve',
      reason: execution.reason,
      createdAt: execution.observedAt,
      executionOutcome: outcome,
      metadata: {
        outcomeId: resolvedOutcomeId,
        verifiedFields: ['caseId', 'actionFingerprint', 'workspaceId', 'latestDecisionId'],
        requestedFields: [],
        unverifiedFields: outcome === 'unknown' ? ['executor outcome'] : [],
      },
    });
    try {
      const appended = appendState({ operationId, event, nextCase, execution });
      return Object.freeze({ ok: true, replayed: appended.replayed, case: freezeClone(appended.state.case), execution: freezeClone(appended.state.execution), receipt: appended.receipt, verification: appended.verification });
    } catch (error) {
      return fail(RUNTIME_REASONS.DURABILITY_UNAVAILABLE, { caseId, message: error.message });
    }
  }

  async function executeApproved({ caseId, action, requesterContext, firewallRequest = {}, executor } = {}) {
    if (typeof executor !== 'function') return fail(RUNTIME_REASONS.APPROVAL_REQUIRED, { reason: 'executor_required' });
    const authorization = authorizeExecution({ caseId, action, requesterContext, firewallRequest });
    if (!authorization.ok) return authorization;
    let result;
    try {
      result = await executor();
    } catch (_) {
      const recorded = recordExecutionOutcome({ caseId, outcome: 'unknown', reason: RUNTIME_REASONS.EXECUTION_RECORDED_AS_UNKNOWN });
      return Object.freeze({ ok: false, allowed: false, reason: RUNTIME_REASONS.EXECUTION_RECONCILIATION_REQUIRED, execution: recorded });
    }
    const outcome = result && result.ok === false ? 'failed' : 'succeeded';
    const recorded = recordExecutionOutcome({ caseId, outcome, reason: outcome === 'succeeded' ? 'executor_completed' : 'executor_returned_failure' });
    if (!recorded.ok) return Object.freeze({ ok: false, allowed: false, reason: RUNTIME_REASONS.EXECUTION_RECONCILIATION_REQUIRED, result, execution: recorded });
    return Object.freeze({ ok: outcome === 'succeeded', allowed: outcome === 'succeeded', result: cloneJson(result, 'executor result'), execution: recorded });
  }

  function getReviewCase(caseId) {
    return readCase(caseId);
  }

  return Object.freeze({
    version: HUMAN_OVERSIGHT_RUNTIME_VERSION,
    createReviewCase,
    decide,
    getReviewCase,
    getEvidenceView: (caseId) => buildEvidenceView(readCase(caseId)),
    authorizeExecution,
    recordExecutionOutcome,
    executeApproved,
    reasons: RUNTIME_REASONS,
    decisionTypes: DECISION_TYPES,
    caseStatuses: CASE_STATUSES,
  });
}

module.exports = Object.freeze({
  HUMAN_OVERSIGHT_RUNTIME_VERSION,
  REVIEW_CASE_SCHEMA_VERSION,
  APPROVAL_DECISION_SCHEMA_VERSION,
  STATE_RECORD_SCHEMA_VERSION,
  DECISION_TYPES,
  CASE_STATUSES,
  EXECUTION_OUTCOMES,
  RUNTIME_REASONS,
  createHumanOversightApprovalRuntime,
  normalizeAction,
});
