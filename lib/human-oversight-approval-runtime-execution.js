'use strict';

// #2148: acting on an approved case -- authorization against the firewall,
// the single-use execution reservation, and the recorded outcome.

const {
  APPROVAL_DECISION_SCHEMA_VERSION,
  EXECUTION_OUTCOMES,
  MAX_REASON,
  RUNTIME_REASONS,
  isPlainObject,
  cloneJson,
  boundedText,
  safeMetadata,
  nowMillis,
  isoAt,
  makeId,
  freezeClone,
  fail,
  normalizeAction,
  decisionOperationId,
  outcomeOperationId,
  buildLedgerEvent,
  AGENT_ACTION_FIREWALL_DECISIONS,
  executionReservationOperationId,
} = require('./human-oversight-approval-runtime-primitives');

function createApprovalExecution({ firewallEvaluator, clock, readResult, readCase, resolveRoleIdentity, appendState }) {
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
    const fields = ['workspaceId', 'connectorRef', 'resourceRef', 'actionFingerprint', 'policyVersion', 'firewallVersion', 'requestedVerdict', 'riskScore'];
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
    if (!['approved', 'executing', 'executed', 'reconciliation_required'].includes(current.status)) return fail(RUNTIME_REASONS.APPROVAL_REQUIRED, { caseId });
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
    // Durable execution reservation (#1867): the claim is committed before the
    // executor runs, so a concurrent second call authorizes against `approved`
    // no longer -- it finds `executing` and fails closed. The reservation id
    // is deterministic per case, so even two processes racing past
    // authorization collide on the journal's once-semantics and the replayed
    // loser aborts without running. A crash between claim and outcome leaves
    // the case in `executing`, which authorizes nothing and retries nothing;
    // recovery is an explicit reconciling outcome, never automatic.
    const reservation = reserveExecution({ caseId, authorizedCase: authorization.case });
    if (!reservation.ok) return reservation;
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

  function reserveExecution({ caseId, authorizedCase } = {}) {
    const now = nowMillis(clock);
    if (now === null) return fail(RUNTIME_REASONS.DURABILITY_UNAVAILABLE, { reason: 'clock_unavailable' });
    const operationId = executionReservationOperationId(caseId);
    const nextCase = {
      ...cloneJson(authorizedCase, 'case'),
      status: 'executing',
    };
    const event = buildLedgerEvent({
      workspaceId: authorizedCase.workspaceId,
      operationId,
      caseRecord: authorizedCase,
      eventType: 'execution_reserved',
      decisionType: 'approve',
      reason: 'execution_claim_reserved',
      createdAt: isoAt(now),
      metadata: { reservation: 'execution_claim' },
    });
    let appended;
    try {
      appended = appendState({ operationId, event, nextCase });
    } catch (error) {
      return fail(RUNTIME_REASONS.DURABILITY_UNAVAILABLE, { caseId, message: error.message });
    }
    if (appended.replayed) {
      return fail(RUNTIME_REASONS.EXECUTION_ALREADY_RESERVED, { caseId });
    }
    return Object.freeze({ ok: true, case: freezeClone(appended.state.case), receipt: appended.receipt || null });
  }

  return { authorizeExecution, recordExecutionOutcome, executeApproved };
}
module.exports = { createApprovalExecution };
