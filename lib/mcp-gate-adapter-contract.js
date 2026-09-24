'use strict';

// #2169: the adapter's contract -- version, per-tool classifications,
// decisions, risk scores by level and reason codes.

const { RISK_LEVELS } = require('./action-risk-classifier');
const { highestPercentRiskScore } = require('./risk-scale');

const MCP_GATE_ADAPTER_VERSION = 'V2.6-PR1-v0.1.0';

/**
 * Keyed on the RFC-001 canonical `huqan.*` names. `classifyMcpTool` resolves the
 * deprecated `axiom.*` aliases through `canonicalMcpToolName` first, so a legacy
 * call is classified — and therefore gated — identically to a canonical one. The
 * gate is not a place where the two spellings may diverge.
 *
 * A tool's `gates` list is a claim about what actually runs. Anything a
 * consumer reads here it is entitled to assume was evaluated, so a gate named
 * in this table and skipped at runtime is worse than an absent one: it reports
 * a protection that does not exist. Two such gaps were closed by making the
 * table honest rather than by adding enforcement:
 *
 * AB6 (sandbox isolation) is deliberately not evaluated on this surface. The
 * module was imported and an input builder written, but no code path ever
 * called them and no tool listed AB6, so the control was dead while looking
 * present (#1253). Sandbox isolation is a property of how a runner is
 * launched, not of an MCP tool invocation, and this adapter has no runner to
 * describe -- the dead builder had to invent `runner: 'unknown'` and
 * `hasSnapshot: false` to call it at all. Enforcing it here would mean gating
 * on values the caller supplies about its own sandbox, which is not a
 * boundary. If AB6 is ever enforced it belongs where the sandbox is created,
 * and `lib/sandbox-isolation.js` remains available for that.
 *
 * AB4 (memory mutation) is listed only by `huqan.learn`, which is the only
 * tool the AB4 block below actually runs for. `huqan.ingest_execute` used to
 * list it too while never being evaluated (#1254); its memory mutation goes
 * through `decideMcpIngestApproval` -> `decideIngestApproval`, which owns its
 * own admission, so AB4 not running there is the design -- advertising it was
 * the defect.
 */
const MCP_TOOL_CLASSIFICATIONS = Object.freeze({
  'huqan.web_research': Object.freeze({ mutating: false, category: 'read', alphaDecision: 'allow', gates: ['AB1', 'AB9', 'AB11'] }),
  'huqan.ask': Object.freeze({ mutating: false, category: 'read', alphaDecision: 'allow', gates: ['AB1', 'AB11'] }),
  'huqan.verify': Object.freeze({ mutating: false, category: 'read', alphaDecision: 'allow', gates: ['AB1', 'AB11'] }),
  'huqan.plan': Object.freeze({ mutating: false, category: 'read', alphaDecision: 'allow', gates: ['AB1', 'AB11'] }),
  'huqan.policy': Object.freeze({ mutating: false, category: 'read', alphaDecision: 'allow', gates: ['AB1', 'AB11'] }),
  'huqan.approvals': Object.freeze({ mutating: false, category: 'read', alphaDecision: 'allow', gates: ['AB1', 'AB11'] }),
  'huqan.approval_detail': Object.freeze({ mutating: false, category: 'read', alphaDecision: 'allow', gates: ['AB1', 'AB11'] }),
  'huqan.reason': Object.freeze({ mutating: false, category: 'read', alphaDecision: 'allow', gates: ['AB1', 'AB11'] }),
  'huqan.compare': Object.freeze({ mutating: false, category: 'read', alphaDecision: 'allow', gates: ['AB1', 'AB11'] }),
  'huqan.dream': Object.freeze({ mutating: false, category: 'read', alphaDecision: 'allow', gates: ['AB1', 'AB11'] }),
  'huqan.advocate': Object.freeze({ mutating: false, category: 'read', alphaDecision: 'allow', gates: ['AB1', 'AB11'] }),
  'huqan.search': Object.freeze({ mutating: false, category: 'read', alphaDecision: 'allow', gates: ['AB1', 'AB11'] }),
  'huqan.trust_receipt': Object.freeze({ mutating: false, category: 'read', alphaDecision: 'allow', gates: ['AB1', 'AB11'] }),
  'huqan.status': Object.freeze({ mutating: false, category: 'read', alphaDecision: 'allow', gates: ['AB1', 'AB11'] }),
  'huqan.audit': Object.freeze({ mutating: false, category: 'read', alphaDecision: 'allow', gates: ['AB1', 'AB11'] }),
  'huqan.trust_receipt_detail': Object.freeze({ mutating: false, category: 'read', alphaDecision: 'allow', gates: ['AB1', 'AB11'] }),
  'huqan.ingest_preview': Object.freeze({ mutating: false, category: 'read', alphaDecision: 'allow', gates: ['AB1', 'AB11'] }),
  // No AB4: ingest's memory mutation is admitted by decideIngestApproval, not
  // by this gate. See the AB4 note above (#1254).
  'huqan.ingest_execute': Object.freeze({ mutating: true, category: 'write', alphaDecision: 'review', gates: ['AB1', 'AB2', 'AB11'] }),
  // Reads an existing run's projection. It cannot claim, decide or execute the
  // approval it reads, so it classifies with the other read tools.
  'huqan.ingest_status': Object.freeze({ mutating: false, category: 'read', alphaDecision: 'allow', gates: ['AB1', 'AB11'] }),
  'huqan.learn': Object.freeze({ mutating: true, category: 'write', alphaDecision: 'review', gates: ['AB1', 'AB2', 'AB4', 'AB11'] }),
  // fractal-learn writes through kernel.dream({learnFromDream:true}) -> admission
  // (not the AB4 branch), so it lists AB4 nowhere; same gate shape as ingest_execute.
  'huqan.fractal-learn': Object.freeze({ mutating: true, category: 'write', alphaDecision: 'review', gates: ['AB1', 'AB2', 'AB11'] }),
  // self-evolve runs fractal-learn and then a self-evolution pass, so it writes
  // through the same admission path plus the threshold surface the probe
  // measures. Same gates as fractal-learn -- the extra reach is in what the run
  // may change, not in which gate admits it.
  'huqan.self-evolve': Object.freeze({ mutating: true, category: 'write', alphaDecision: 'review', gates: ['AB1', 'AB2', 'AB11'] }),
  'huqan.agent': Object.freeze({ mutating: false, category: 'agent-loop', alphaDecision: 'dry_run_only', gates: ['AB1', 'AB2', 'AB5', 'AB8', 'AB9', 'AB11'] }),
});

const MCP_GATE_DECISIONS = Object.freeze({
  allow: 'allow',
  review: 'review',
  block: 'block',
  dry_run_only: 'dry_run_only',
  disabled: 'disabled',
});

const MCP_RISK_SCORE_BY_LEVEL = Object.freeze({
  [RISK_LEVELS.LOW]: 0,
  [RISK_LEVELS.MEDIUM]: 50,
  [RISK_LEVELS.HIGH]: 80,
  [RISK_LEVELS.CRITICAL]: 100,
});

function riskScoreForLevel(level) {
  return MCP_RISK_SCORE_BY_LEVEL[String(level || '').trim().toUpperCase()] ?? 0;
}

// Findings are on 0-100: AB2/AB4/AB5 scores are converted where taken (#2505).
const highestFindingRiskScore = (findings = []) => highestPercentRiskScore(findings, riskScoreForLevel);

const MCP_GATE_REASONS = Object.freeze({
  READ_ONLY_ALLOW: 'read_only_allow',
  MUTATING_REVIEW: 'mutating_requires_review',
  AGENT_LOOP_DRY_RUN: 'agent_loop_dry_run_only',
  UNKNOWN_TOOL_BLOCK: 'unknown_tool_blocked',
  AB1_BLOCKED: 'ab1_risk_classifier_blocked',
  AB2_BLOCKED: 'ab2_tool_call_gate_blocked',
  AB4_BLOCKED: 'ab4_memory_mutation_gate_blocked',
  AB5_BLOCKED: 'ab5_automation_safety_gate_blocked',
  // No AB6 reason: sandbox isolation is deliberately not evaluated here. See
  // the note above MCP_TOOL_CLASSIFICATIONS (#1253).
  AB8_BLOCKED: 'ab8_command_exec_gate_blocked',
  AB8_REVIEW: 'ab8_command_exec_review_required',
  AB9_EGRESS_REVIEW: 'ab9_data_egress_review_required',
  AB11_CROSS_WORKSPACE_BLOCKED: 'ab11_cross_workspace_access_blocked',
  AB11_CROSS_WORKSPACE_REVIEW: 'ab11_cross_workspace_access_review_required',
  MALFORMED_INPUT: 'malformed_input_blocked',
  GATE_ERROR: 'gate_evaluation_error',
});

module.exports = {
  MCP_GATE_ADAPTER_VERSION,
  MCP_GATE_DECISIONS,
  MCP_GATE_REASONS,
  MCP_RISK_SCORE_BY_LEVEL,
  MCP_TOOL_CLASSIFICATIONS,
  highestFindingRiskScore,
  riskScoreForLevel,
};
