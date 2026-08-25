'use strict';

const { readCompatibleEnvironmentVariable } = require('./environment-compat');

/**
 * A single, explicit off switch for the human-approval / review gate
 * (#321: "insan onay mekanizması için on off seçeneği ... zamanla sıkıcı
 * hale gelir sürekli onay vermek" -- constantly approving becomes tedious
 * over time).
 *
 * Controlled by HUQAN_HUMAN_APPROVAL_DISABLED=true. Deliberately narrow:
 * only auto-approves a `review` decision. A `block` decision is never
 * touched by this -- those are hard security denials (AB1 critical risk,
 * AB2 blocked tool calls, AB11 cross-workspace denials, etc.), and this
 * toggle exists to skip repetitive manual-approval clicks, not to disable
 * the gates that refuse something outright. Default is unset (approval
 * stays required) -- fail-closed, opt-out rather than opt-in.
 *
 * Auto-approval is never silent: the original decision/reason survive in
 * the returned gate's metadata (originalDecision/originalReason), which
 * flows into lib/gate-telemetry.js's afterGateDecision event the same way
 * any other gate metadata does -- so metric-collector.js (#212) and any
 * other afterGateDecision observer can see exactly how many review
 * decisions were auto-approved and why, rather than the toggle silently
 * making them look identical to a plain allow.
 */

function isHumanApprovalDisabled(env = process.env) {
  return readCompatibleEnvironmentVariable('HUMAN_APPROVAL_DISABLED', env) === 'true';
}

/**
 * `huqan.agent` historically carries a blanket alpha `dry_run_only` fallback
 * even after AB1/AB2/AB5/AB8/AB9/AB11 have evaluated the request. That made a
 * completely clean agent call impossible to execute through the normal MCP
 * path, despite dispatchMcpTool having a real agent.run() implementation.
 *
 * Release only that blanket fallback, and only when every concrete gate
 * finding is non-escalating. Any review/dry-run finding, AB9 egress signal,
 * warning, or block keeps the original fail-closed decision. This preserves
 * the existing gate evidence while allowing a clean agent loop to reach the
 * guarded agent runtime.
 */
function releaseCleanAgentLoop(gate) {
  if (!gate
    || gate.decision !== 'dry_run_only'
    || gate.reason !== 'agent_loop_dry_run_only'
    || gate.metadata?.tool !== 'huqan.agent') {
    return gate;
  }

  if (Array.isArray(gate.warnings) && gate.warnings.length > 0) return gate;

  const escalated = Array.isArray(gate.findings) && gate.findings.some((finding) => {
    const decision = String(finding?.decision || '').toLowerCase();
    if (['block', 'review', 'human_review', 'quarantine', 'dry_run_only'].includes(decision)) return true;
    return finding?.gate === 'AB9' && (finding.piiDetected === true || finding.secretDetected === true);
  });
  if (escalated) return gate;

  return {
    ...gate,
    decision: 'allow',
    allowed: true,
    canExecute: true,
    canDryRun: false,
    requiredReview: false,
    dryRunOnly: false,
    reason: 'agent_loop_gates_passed',
    metadata: {
      ...gate.metadata,
      agentExecutionReleased: true,
      originalDecision: gate.decision,
      originalReason: gate.reason,
    },
  };
}

/**
 * The default `approvalRequired` value kernel.js's memory-admission path
 * falls back to when a caller doesn't specify one explicitly. This is the
 * layer that actually produces the "onayla:"-requiring pending state --
 * independent of, and evaluated separately from, the MCP gate decision
 * applyHumanApprovalToggle() adjusts. Both had to change for the toggle to
 * do what #321 asks: an MCP call that applyHumanApprovalToggle() lets
 * through still lands in kernel.learn(), which runs its own
 * evaluateMemoryAdmission() and would otherwise still default to pending.
 */
function defaultApprovalRequired(env = process.env) {
  return !isHumanApprovalDisabled(env);
}

function applyHumanApprovalToggle(gate, env = process.env) {
  const runtimeGate = releaseCleanAgentLoop(gate);
  if (!runtimeGate || runtimeGate.decision !== 'review' || !isHumanApprovalDisabled(env)) {
    return runtimeGate;
  }
  return {
    ...runtimeGate,
    decision: 'allow',
    allowed: true,
    canExecute: true,
    requiredReview: false,
    reason: 'AUTO_APPROVED_HUMAN_APPROVAL_DISABLED',
    metadata: {
      ...runtimeGate.metadata,
      autoApproved: true,
      autoApprovedReason: 'human_approval_disabled',
      originalDecision: runtimeGate.decision,
      originalReason: runtimeGate.reason,
    },
  };
}

module.exports = {
  isHumanApprovalDisabled,
  applyHumanApprovalToggle,
  defaultApprovalRequired,
  releaseCleanAgentLoop,
};
