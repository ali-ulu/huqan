'use strict';

const crypto = require('node:crypto');
const {
  AGENT_ACTION_FIREWALL_VERSION,
  AGENT_ACTION_FIREWALL_DECISIONS,
  evaluateAgentActionFirewall,
} = require('../agent-action-firewall');

const SELF_HEALER_APPROVAL_BRIDGE_VERSION = 'self-healer-approval-bridge-v0.1.0';
const DEFAULT_TOOL_NAME = 'self-healer.dryrun';
const MAX_PROPOSALS = 64;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value, fallback = '') {
  const result = String(value == null ? '' : value).trim();
  return result || fallback;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function refsFromFinding(finding) {
  const evidenceRefs = Array.isArray(finding?.evidence)
    ? finding.evidence.map((item) => text(item?.ref)).filter(Boolean).slice(0, 32)
    : [];
  const provenanceRefs = [text(finding?.findingId)].filter(Boolean);
  return { evidenceRefs, provenanceRefs };
}

function actionForProposal(proposal, finding, workspaceId, firewallVersion) {
  const refs = refsFromFinding(finding);
  const findingId = text(proposal?.findingId || finding?.findingId, 'unknown-finding');
  const actionType = text(proposal?.approvalRequest?.actionType, 'self_healer_proposal');
  const requestedVerdict = text(proposal?.approvalRequest?.requestedVerdict, 'review');
  const requestedEffect = 'review';
  const actionFingerprint = stableHash({
    version: SELF_HEALER_APPROVAL_BRIDGE_VERSION,
    workspaceId,
    findingId,
    decision: text(proposal?.decision),
    refs,
  });
  return {
    actionFingerprint,
    workspaceId,
    connectorRef: 'self-healer',
    resourceRef: findingId,
    policyVersion: text(proposal?.approvalRequest?.trustPolicyVersion, 'self-healer-dryrun-v0.1.0'),
    firewallVersion,
    requestedVerdict,
    requestedEffect,
    actionType,
    toolName: text(proposal?.approvalRequest?.toolName, DEFAULT_TOOL_NAME),
    target: findingId,
    agentId: text(proposal?.approvalRequest?.agentId, 'self-healer'),
    evidenceRefs: refs.evidenceRefs,
    provenanceRefs: refs.provenanceRefs,
    evidenceDigest: stableHash({ findingId, refs }),
    riskScore: Number(proposal?.approvalRequest?.riskScore ?? 50),
  };
}

function approvalBridgeUnavailable(reason = 'approval_runtime_not_configured') {
  const unavailable = {
    ok: false,
    status: 'not_configured',
    reason,
    created: Object.freeze([]),
    blocked: Object.freeze([]),
    applied: false,
    executed: false,
  };
  unavailable.bridge = () => Object.freeze({ ...unavailable });
  return Object.freeze(unavailable);
}

/**
 * Materialize dry-run review proposals as Human Oversight cases.
 *
 * This bridge never executes a proposed fix. It only creates an immutable,
 * receiver-owned review case after a second firewall evaluation. Missing
 * runtime, identity context, ambiguous firewall decisions and runtime errors
 * all remain blocked and are returned as bounded metadata.
 */
function createSelfHealerApprovalBridge({
  approvalRuntime,
  requesterContext,
  resolveFirewall = evaluateAgentActionFirewall,
  firewallVersion = AGENT_ACTION_FIREWALL_VERSION,
} = {}) {
  if (!isObject(approvalRuntime) || typeof approvalRuntime.createReviewCase !== 'function') {
    return approvalBridgeUnavailable();
  }
  if (!isObject(requesterContext)) {
    return approvalBridgeUnavailable('requester_context_required');
  }
  if (typeof resolveFirewall !== 'function') {
    return approvalBridgeUnavailable('firewall_evaluator_required');
  }

  function bridge({ proposals = [], findings = [], workspaceId = 'default', runId = '', auditReportId = '' } = {}) {
    if (!Array.isArray(proposals) || !Array.isArray(findings)) {
      return approvalBridgeUnavailable('proposal_and_finding_arrays_required');
    }
    const byFindingId = new Map(findings.map((finding) => [text(finding?.findingId), finding]));
    const candidates = proposals
      .filter((proposal) => proposal?.requiresApproval === true && proposal?.approvalRequest)
      .slice(0, MAX_PROPOSALS);
    const created = [];
    const blocked = [];

    for (const proposal of candidates) {
      const finding = byFindingId.get(text(proposal.findingId));
      const findingId = text(proposal.findingId, 'unknown-finding');
      const firewallDecision = resolveFirewall({
        surface: 'self-healer',
        tool: DEFAULT_TOOL_NAME,
        action: 'review',
        input: {
          action: 'review',
          target: findingId,
          dryRun: true,
          preview: true,
        },
        context: {
          workspaceId,
          actor: text(requesterContext.actor, 'self-healer'),
          target: findingId,
          dryRun: true,
          preview: true,
        },
        preview: true,
        dryRun: true,
      });
      const decision = firewallDecision?.decision;
      if (![AGENT_ACTION_FIREWALL_DECISIONS.REVIEW, AGENT_ACTION_FIREWALL_DECISIONS.BLOCK,
        AGENT_ACTION_FIREWALL_DECISIONS.DRY_RUN_ONLY].includes(decision)) {
        blocked.push({ findingId, reason: 'firewall_revalidation_not_reviewable' });
        continue;
      }

      const action = actionForProposal(proposal, finding || {}, workspaceId,
        text(firewallDecision?.metadata?.firewallVersion, firewallVersion));
      const caseId = `self-healer:${text(proposal.approvalRequest.approvalId, findingId)}`;
      let result;
      try {
        result = approvalRuntime.createReviewCase({
          action,
          firewallDecision: decision,
          requesterContext,
          caseId,
          metadata: {
            source: 'self-healer-dryrun',
            runId: text(runId),
            auditReportId: text(auditReportId),
            findingId,
            approvalRequestId: text(proposal.approvalRequest.approvalId),
          },
        });
      } catch (_) {
        result = { ok: false, reason: 'approval_runtime_failed' };
      }
      if (result?.ok === true) {
        created.push({ findingId, caseId, replayed: Boolean(result.replayed), receiptId: text(result.receipt?.receiptId) || null });
      } else {
        blocked.push({ findingId, reason: text(result?.reason, 'approval_case_blocked') });
      }
    }

    return Object.freeze({
      ok: blocked.length === 0,
      status: blocked.length === 0 ? 'materialized' : 'partially_blocked',
      created: Object.freeze(created),
      blocked: Object.freeze(blocked),
      applied: false,
      executed: false,
    });
  }

  return Object.freeze({
    version: SELF_HEALER_APPROVAL_BRIDGE_VERSION,
    bridge,
  });
}

module.exports = {
  SELF_HEALER_APPROVAL_BRIDGE_VERSION,
  createSelfHealerApprovalBridge,
  approvalBridgeUnavailable,
};
