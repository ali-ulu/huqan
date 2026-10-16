'use strict';

// Primitives shared by the human oversight approval runtime: operation ids
// and the ledger event. Values live in
// human-oversight-approval-runtime-primitives-values.js, input normalization in
// human-oversight-approval-runtime-primitives-normalize.js (#2219).

const { AGENT_ACTION_FIREWALL_DECISIONS, evaluateAgentActionFirewall } = require('./agent-action-firewall');
const { TRUST_EVIDENCE_SCHEMA_VERSION, buildTrustEvidencePayload } = require('./trust-evidence-ledger');
const { isPlainObject } = require('./is-plain-object');
const { fail, freezeClone, hashObject, isoAt, makeId, normalizeAction, normalizeIdentity, normalizePolicy, nowMillis, parseInstant, validFirewallDecision, verdictForEvent } = require('./human-oversight-approval-runtime-primitives-normalize');
const { APPROVAL_DECISION_SCHEMA_VERSION, CASE_STATUSES, DECISION_TYPES, DEFAULT_CASE_LIFETIME_MS, EXECUTION_OUTCOMES, HUMAN_OVERSIGHT_RUNTIME_VERSION, MAX_CASE_LIFETIME_MS, MAX_HISTORY, MAX_METADATA_BYTES, MAX_REASON, MAX_REFS, MAX_TEXT, REVIEW_CASE_SCHEMA_VERSION, RUNTIME_REASONS, STATE_RECORD_SCHEMA_VERSION, boundedRefs, boundedText, cloneJson, safeMetadata } = require('./human-oversight-approval-runtime-primitives-values');

function caseOperationId(caseId) {
  return `human-oversight:review-case:create:${caseId}`;
}

function decisionOperationPrefix(caseId) {
  return `human-oversight:approval-decision:${caseId}:`;
}

function decisionOperationId(caseId, decisionId) {
  return `${decisionOperationPrefix(caseId)}${decisionId}`;
}

function outcomeOperationId(caseId, outcomeId) {
  return `human-oversight:execution-outcome:${caseId}:${outcomeId}`;
}

/**
 * The durable execution claim for one case (#1867). Deterministic per case so
 * the mutation journal's once-semantics make the first writer the only
 * holder: a concurrent second reservation replays and loses. Kept on its own
 * prefix so it can never collide with an execution-outcome operation id.
 */
function executionReservationPrefix(caseId) {
  return `human-oversight:execution-reservation:${caseId}:`;
}

function executionReservationOperationId(caseId) {
  return `${executionReservationPrefix(caseId)}claim`;
}

function buildLedgerEvent({ workspaceId, operationId, caseRecord, eventType, decisionType, reason, createdAt, metadata = {}, executionOutcome = 'not_attempted' }) {
  const verdict = verdictForEvent(eventType, decisionType);
  return {
    workspaceId,
    operationId,
    decision: verdict,
    reason: boundedText(reason, 'reason', { max: MAX_REASON }),
    actionFingerprint: caseRecord.actionFingerprint,
    identityRef: caseRecord.requester.identityRef,
    identityHash: caseRecord.requester.identityHash,
    authorityRef: caseRecord.requester.authorityRef,
    delegationRef: caseRecord.requester.delegationRef,
    policyVersion: caseRecord.policyVersion,
    firewallVersion: caseRecord.firewallVersion,
    connectorRef: caseRecord.connectorRef,
    resourceRef: caseRecord.resourceRef,
    approvalRef: caseRecord.caseId,
    executionOutcome,
    sourceRefs: caseRecord.evidenceRefs,
    provenanceRefs: caseRecord.provenanceRefs,
    createdAt,
    metadata: safeMetadata({
      runtimeVersion: HUMAN_OVERSIGHT_RUNTIME_VERSION,
      schemaVersion: TRUST_EVIDENCE_SCHEMA_VERSION,
      eventType,
      decisionType,
      reviewCaseId: caseRecord.caseId,
      requestedVerdict: caseRecord.requestedVerdict,
      ...metadata,
    }),
  };
}


module.exports = Object.freeze({
  HUMAN_OVERSIGHT_RUNTIME_VERSION,
  REVIEW_CASE_SCHEMA_VERSION,
  APPROVAL_DECISION_SCHEMA_VERSION,
  STATE_RECORD_SCHEMA_VERSION,
  DECISION_TYPES,
  CASE_STATUSES,
  EXECUTION_OUTCOMES,
  MAX_TEXT,
  MAX_REASON,
  MAX_REFS,
  MAX_HISTORY,
  MAX_METADATA_BYTES,
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
  executionReservationPrefix,
  executionReservationOperationId,
  buildLedgerEvent,
  AGENT_ACTION_FIREWALL_DECISIONS,
  evaluateAgentActionFirewall,
  TRUST_EVIDENCE_SCHEMA_VERSION,
  buildTrustEvidencePayload,
});
