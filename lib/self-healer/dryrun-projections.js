'use strict';

/**
 * Pure projection builders for the self-healer dry-run.
 *
 * Extracted from `dryrun-runner.js`, which keeps the run orchestration and
 * the AB10 loop-budget gate. Everything here is a deterministic, side-effect
 * free projection from (finding, decision, context) to one of the durable
 * shapes the dry-run emits: the run id, the approval request and its
 * allowlisted action payload, and the `trust_receipt_summary` from
 * `docs/self-healer-contracts.md` section 7.
 *
 * The code is moved, not rewritten: every function body is byte identical to
 * its previous form in `dryrun-runner.js`.
 */

const crypto = require('node:crypto');

const {
  SELF_HEALER_DECISIONS,
} = require('./safety-decision');
const { buildApprovalRequest } = require('../approval-schema');

const SELF_HEALER_DRYRUN_VERSION = 'self-healer-dryrun-v0.1.0';
const SELF_HEALER_DRYRUN_MODE = 'dry_run';

const APPROVAL_ACTION_TYPE = 'self_healer_proposal';
const APPROVAL_TOOL_NAME = 'self-healer.dryrun';

const RISK_SCORE_BY_SEVERITY = Object.freeze({
  info: 5,
  low: 25,
  medium: 50,
  high: 75,
  critical: 95,
});

function normalizeString(value, fallback = '') {
  const text = String(value == null ? '' : value).trim();
  return text || fallback;
}

function stableHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function riskScoreForSeverity(severity) {
  const key = normalizeString(severity).toLowerCase();
  return Object.prototype.hasOwnProperty.call(RISK_SCORE_BY_SEVERITY, key)
    ? RISK_SCORE_BY_SEVERITY[key]
    : RISK_SCORE_BY_SEVERITY.medium;
}

/**
 * `block` findings are refused outright, so they never become an approval
 * request. Everything else that needs a human is requested as `review` --
 * never `allow`, and never `dry_run_only`, because a self-proposed change
 * must not be able to describe itself as pre-authorized.
 */
function requestedVerdictFor(decision) {
  return decision === SELF_HEALER_DECISIONS.BLOCK ? 'block' : 'review';
}

/**
 * Copies only the fields that are safe to persist into a durable approval
 * record. This is an allowlist on purpose: it is what guarantees no patch
 * text, and no arbitrary caller-supplied field, reaches the approval store.
 */
function buildActionPayload(finding, decisionResult) {
  return {
    findingId: finding.findingId,
    kind: finding.kind,
    severity: finding.severity,
    title: finding.title,
    summary: finding.summary,
    affectedFiles: [...finding.affectedFiles],
    suggestedTests: [...finding.suggestedTests],
    suggestedFixSummary: normalizeString(finding.suggestedFix && finding.suggestedFix.summary),
    riskFlags: [...decisionResult.riskFlags],
    decision: decisionResult.decision,
    allowedNextSteps: [...decisionResult.allowedNextSteps],
    applied: false,
    patchIncluded: false,
  };
}

/**
 * Emits the `trust_receipt_summary` shape from
 * `docs/self-healer-contracts.md` section 7. This is explicitly a summary,
 * not a canonical Trust Receipt: it is not hash-chained and is not written
 * through the receipt chain. It records why a proposal was safe or blocked.
 */
function buildReceiptSummary(finding, decisionResult, context) {
  const payload = {
    version: SELF_HEALER_DRYRUN_VERSION,
    runId: context.runId,
    findingId: finding.findingId,
    decision: decisionResult.decision,
    reason: decisionResult.reason,
    workspaceId: context.workspaceId,
  };

  return {
    receiptId: `shr_${stableHash(payload).slice(0, 16)}`,
    receiptKind: 'self_healer_dryrun_summary',
    runId: context.runId,
    findingId: finding.findingId,
    decision: decisionResult.decision,
    reason: decisionResult.reason,
    evidenceSummary: {
      evidenceCount: finding.evidence.length,
      affectedFileCount: finding.affectedFiles.length,
      suggestedTestCount: finding.suggestedTests.length,
    },
    riskSummary: {
      severity: finding.severity,
      confidence: finding.confidence,
      riskFlags: [...decisionResult.riskFlags],
    },
    approvalRequired: decisionResult.requiresApproval,
    scopeSummary: {
      workspaceId: context.workspaceId,
      mode: SELF_HEALER_DRYRUN_MODE,
      applied: false,
    },
    policyVersion: SELF_HEALER_DRYRUN_VERSION,
    createdAt: context.createdAt,
  };
}

function buildProposalApprovalRequest(finding, decisionResult, context) {
  if (!decisionResult.requiresApproval) return null;

  const approvalId = `sha_${stableHash({
    runId: context.runId,
    findingId: finding.findingId,
    decision: decisionResult.decision,
  }).slice(0, 16)}`;

  const result = buildApprovalRequest({
    approvalId,
    workspaceId: context.workspaceId,
    agentId: context.agentId,
    actor: context.actor,
    owner: context.owner,
    actionType: APPROVAL_ACTION_TYPE,
    toolName: APPROVAL_TOOL_NAME,
    requestedVerdict: requestedVerdictFor(decisionResult.decision),
    reason: decisionResult.reason,
    // The finding is the provenance of the proposal: the proposal exists
    // because of that finding and nothing else.
    provenanceId: finding.findingId,
    trustPolicyVersion: SELF_HEALER_DRYRUN_VERSION,
    status: 'pending',
    riskScore: riskScoreForSeverity(finding.severity),
    createdAt: context.createdAt,
    actionPayload: buildActionPayload(finding, decisionResult),
  });

  return result;
}

function createRunId(input) {
  return `shrun_${stableHash(input).slice(0, 16)}`;
}

module.exports = {
  SELF_HEALER_DRYRUN_VERSION,
  SELF_HEALER_DRYRUN_MODE,
  RISK_SCORE_BY_SEVERITY,
  normalizeString,
  stableHash,
  riskScoreForSeverity,
  requestedVerdictFor,
  buildActionPayload,
  buildReceiptSummary,
  buildProposalApprovalRequest,
  createRunId,
};
