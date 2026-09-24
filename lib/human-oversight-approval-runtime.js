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
  RUNTIME_REASONS,
  DEFAULT_CASE_LIFETIME_MS,
  MAX_CASE_LIFETIME_MS,
  evaluateAgentActionFirewall,
  normalizeAction,
} = require('./human-oversight-approval-runtime-primitives');
const { createApprovalState } = require('./human-oversight-approval-runtime-state');
const { createApprovalCases } = require('./human-oversight-approval-runtime-cases');
const { createApprovalDecisions } = require('./human-oversight-approval-runtime-decide');
const { createApprovalExecution } = require('./human-oversight-approval-runtime-execution');

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
  // #2148: the runtime is composed from single-job modules; each receives
  // exactly the collaborators its moved code already used.
  const { readResult, readCase, resolveRoleIdentity, appendState } = createApprovalState({ graph, ledger, resolveIdentity, clock });
  const { createReviewCase, buildEvidenceView } = createApprovalCases({ clock, lifetime, readResult, resolveRoleIdentity, appendState });
  const { decide } = createApprovalDecisions({ graph, clock, readResult, readCase, resolveRoleIdentity, appendState });
  const { authorizeExecution, recordExecutionOutcome, executeApproved } = createApprovalExecution({
    firewallEvaluator, clock, readResult, readCase, resolveRoleIdentity, appendState,
  });

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
