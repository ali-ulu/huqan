'use strict';

// #2148: the approval runtime's durable state -- committed mutation reads,
// the replayed case with its expiry, receiver-owned identity resolution, and
// the one ledger append every transition goes through.

const {
  STATE_RECORD_SCHEMA_VERSION,
  MAX_HISTORY,
  RUNTIME_REASONS,
  cloneJson,
  boundedText,
  nowMillis,
  freezeClone,
  fail,
  normalizeIdentity,
  caseOperationId,
  decisionOperationPrefix,
  executionReservationPrefix,
  buildTrustEvidencePayload,
} = require('./human-oversight-approval-runtime-primitives');

function createApprovalState({ graph, ledger, resolveIdentity, clock }) {
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
      const prefixes = [decisionOperationPrefix(normalizedCaseId), executionReservationPrefix(normalizedCaseId), `human-oversight:execution-outcome:${normalizedCaseId}:`];
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

  return { readResult, readCase, resolveRoleIdentity, appendState };
}
module.exports = { createApprovalState };
