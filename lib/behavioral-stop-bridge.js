'use strict';

// Behavioral-containment stop bridge (#2505 F-3).
//
// A quarantine, block or pause recommendation from the behavioral gate is a
// proposal, never an action. This bridge turns the recommendation into an
// immutable Human Oversight review case. Execution travels the existing F-2
// operator surfaces (huqan.emergency_stop over MCP/HTTP/CLI); this module
// binds the execution arguments to the approved case so the scope the
// operator stops is the scope that was reviewed. Without an approval runtime
// the bridge reports unavailable and nothing is proposed.
//
// The action shape mirrors lib/self-healer/approval-bridge.js, the proven
// review-case shape in this codebase: requestedVerdict/requestedEffect stay
// 'review' (the case asks for review; approving it authorizes execution),
// and the fingerprint binds scope, deviation and receipt together.

const crypto = require('node:crypto');
const { BEHAVIORAL_CONTAINMENT_VERSION } = require('./self-healer/behavioral-containment');
const { AGENT_ACTION_FIREWALL_VERSION } = require('./agent-action-firewall');

const BRIDGE_VERSION = 'behavioral-stop-bridge-v0.1.0';
const CONNECTOR_REF = 'behavioral-containment';
const STOP_TOOL_NAME = 'behavioral-containment.stop';
const POLICY_VERSION = 'behavioral-stop-bridge-v0.1.0';

// Decisions that open a stop proposal. OBSERVE never proposes. The executor
// admits containment actions (pause/quarantine/block); this module admits
// the decisions behind them, including require_review (pause).
const PROPOSING_DECISIONS = Object.freeze(['quarantine', 'block', 'require_review']);
// Containment actions admitted at the step trigger.
const PROPOSING_CONTAINMENTS = Object.freeze(['pause', 'quarantine', 'block']);

function text(value, fallback = '') {
  const result = typeof value === 'string' ? value.trim() : '';
  return result || fallback;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function stopScopeFor({ workspaceId, agentId } = {}) {
  const agent = text(agentId);
  return { scope: agent ? 'agent' : 'workspace', workspaceId, agentId: agent || null };
}

function riskScoreFor(decision) {
  return decision === 'quarantine' || decision === 'block' ? 90 : 50;
}

/**
 * Open a review case for an emergency stop on the recommended scope.
 *
 * Never throws and never stops anything: without an approval runtime, or for
 * an observe recommendation, it reports back and the caller carries on.
 */
function proposeBehavioralStop({ recommendation = {}, approvalRuntime, requesterContext } = {}) {
  const decision = text(recommendation.decision);
  const scope = stopScopeFor(recommendation.scope);
  if (!PROPOSING_DECISIONS.includes(decision)) {
    return Object.freeze({ ok: true, proposed: false, reason: 'no_containment' });
  }
  if (!approvalRuntime || typeof approvalRuntime.createReviewCase !== 'function') {
    return Object.freeze({ ok: false, proposed: false, reason: 'approval_runtime_not_configured' });
  }
  const deviationCode = text(recommendation.deviationCode);
  const receiptId = text(recommendation.receiptId);
  const resourceRef = receiptId || text(recommendation.baselineHash) || 'unknown-recommendation';
  const action = {
    actionFingerprint: stableHash({
      version: BRIDGE_VERSION,
      workspaceId: scope.workspaceId,
      agentId: scope.agentId,
      decision,
      deviationCode,
      resourceRef,
    }),
    workspaceId: scope.workspaceId,
    connectorRef: CONNECTOR_REF,
    resourceRef,
    policyVersion: POLICY_VERSION,
    firewallVersion: AGENT_ACTION_FIREWALL_VERSION,
    requestedVerdict: 'review',
    requestedEffect: 'review',
    actionType: 'emergency_stop',
    toolName: STOP_TOOL_NAME,
    // The stop target rides `target`: the case journal preserves it while it
    // drops anything else scope-shaped. `agent:<id>` stops one agent,
    // `workspace:<id>` stops every agent, MCP, HTTP and CLI call in the workspace.
    target: scope.agentId ? `agent:${scope.agentId}` : `workspace:${scope.workspaceId}`,
    agentId: scope.agentId,
    evidenceRefs: deviationCode ? [`asi10:${deviationCode}`] : [],
    provenanceRefs: receiptId ? [receiptId] : [],
    evidenceDigest: stableHash({ receiptId: resourceRef, deviationCode, scope }),
    riskScore: riskScoreFor(decision),
  };
  try {
    const created = approvalRuntime.createReviewCase({
      action,
      firewallDecision: 'review',
      requesterContext,
    });
    if (!created || created.ok !== true) {
      return Object.freeze({ ok: false, proposed: false, reason: 'review_case_rejected', detail: created });
    }
    return Object.freeze({ ok: true, proposed: true, case: created.case, receipt: created.receipt || null });
  } catch (error) {
    return Object.freeze({ ok: false, proposed: false, reason: 'bridge_error', message: String(error && error.message || error) });
  }
}

/**
 * Derive the operator stop arguments from an approved case.
 *
 * Only approved cases yield arguments; pending, escalated, rejected or
 * executed cases report back instead of stopping anything. Cases opened by
 * another connector are refused even when approved.
 */
function stopRequestForCase({ approvalRuntime, caseId } = {}) {
  if (!approvalRuntime || typeof approvalRuntime.getReviewCase !== 'function') {
    return Object.freeze({ ok: false, stop: null, reason: 'approval_runtime_not_configured' });
  }
  let read;
  try {
    read = approvalRuntime.getReviewCase(caseId);
  } catch (error) {
    return Object.freeze({ ok: false, stop: null, reason: 'bridge_error', message: String(error && error.message || error) });
  }
  const record = read && read.ok === true ? read.case : null;
  if (!record) {
    return Object.freeze({ ok: false, stop: null, reason: 'case_not_found', caseId: text(caseId) });
  }
  const decided = record.latestDecisionType || record.status;
  if (record.status !== 'approved' || (decided !== 'approve' && decided !== 'override')) {
    return Object.freeze({ ok: false, stop: null, reason: 'case_not_approved', status: record.status || null });
  }
  if (record.connectorRef !== CONNECTOR_REF || record.actionType !== 'emergency_stop') {
    return Object.freeze({ ok: false, stop: null, reason: 'not_a_behavioral_stop_case' });
  }
  // The scope rides the action's `target` (`agent:<id>` or `workspace:<id>'):
  // the case journal preserves it while it drops anything else scope-shaped.
  // An unparseable target fails closed rather than guessing a scope.
  const target = text(record.target);
  const agentMatch = target.match(/^agent:(.+)$/);
  const workspaceMatch = target.match(/^workspace:(.+)$/);
  if (!agentMatch && !workspaceMatch) {
    return Object.freeze({ ok: false, stop: null, reason: 'unrecognized_stop_target' });
  }
  const scope = agentMatch
    ? stopScopeFor({ workspaceId: record.workspaceId, agentId: agentMatch[1] })
    : stopScopeFor({ workspaceId: workspaceMatch[1] || record.workspaceId });
  return Object.freeze({
    ok: true,
    stop: {
      scope: scope.scope,
      workspaceId: scope.workspaceId,
      agentId: scope.agentId || undefined,
      reason: `approved case ${record.caseId}: ${record.resourceRef}`,
    },
    caseId: record.caseId,
  });
}

/**
 * Step-level trigger for lib/agent-step-executor.js: after a behavioral
 * block, open a stop proposal when the runtime carries an approval runtime.
 * Returns null when dormant so the step report is byte-identical without one.
 */
function proposeStopForBlockedStep({ result, state, runtime } = {}) {
  if (result?.meta?.blocked !== true) return null;
  const containment = text(result.meta.containment);
  if (!PROPOSING_CONTAINMENTS.includes(containment)) return null;
  const approvalRuntime = runtime?.humanOversightApprovalRuntime;
  if (!approvalRuntime || typeof approvalRuntime.createReviewCase !== 'function') return null;
  const scope = { workspaceId: state?.workspaceId, agentId: state?.agentId || null };
  const proposal = proposeBehavioralStop({
    recommendation: {
      decision: text(result.meta.behavioralDecision) || containment,
      deviationCode: text(result.meta.behavioralDeviationCode),
      receiptId: text(result.meta.behavioralReceiptId),
      baselineHash: text(result.meta.behavioralBaselineHash),
      scope,
      reason: result?.error?.message || null,
    },
    approvalRuntime,
    requesterContext: {
      subject: `agent:${text(state?.agentId) || 'unknown'}`,
      kind: 'agent-step',
      workspaceId: scope.workspaceId,
      agentId: scope.agentId,
    },
  });
  return proposal;
}

module.exports = {
  BRIDGE_VERSION,
  PROPOSING_CONTAINMENTS,
  PROPOSING_DECISIONS,
  proposeBehavioralStop,
  stopRequestForCase,
  proposeStopForBlockedStep,
  stopScopeFor,
};
