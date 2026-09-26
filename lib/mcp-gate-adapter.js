'use strict';

// The MCP gate adapter: runs one MCP tool call through every applicable gate
// (AB1..AB11) and merges their decisions, failing closed on a gate error.
// Contract, per-gate inputs, decision helpers and the gate runners live in
// mcp-gate-adapter-*.js (#2169).

const { RISK_LEVELS } = require('./action-risk-classifier');
const { riskLevelForScore } = require('./risk-scale');
const { MCP_GATE_ADAPTER_VERSION, MCP_GATE_DECISIONS, MCP_GATE_REASONS, MCP_TOOL_CLASSIFICATIONS, highestFindingRiskScore, riskScoreForLevel } = require('./mcp-gate-adapter-contract');
const { buildDecision, buildMcpJustification, mergeMcpDecisions } = require('./mcp-gate-adapter-decisions');
const { classifyMcpTool, normalizeMcpToolInput } = require('./mcp-gate-adapter-inputs');
const { runAB1, runAB2, runAB5, runAB8 } = require('./mcp-gate-adapter-action-gates');
const { runAB9, runAB11, runAB4 } = require('./mcp-gate-adapter-data-gates');

const GATE_RUNNERS = Object.freeze([
  ['AB1', runAB1], ['AB2', runAB2], ['AB5', runAB5], ['AB8', runAB8],
  ['AB9', runAB9], ['AB11', runAB11], ['AB4', runAB4],
]);

function evaluateMcpGate(input, options = {}) {
  const normalized = normalizeMcpToolInput(input);
  if (normalized.malformed) {
    return buildDecision(MCP_GATE_DECISIONS.block, MCP_GATE_REASONS.MALFORMED_INPUT, {
      ok: true, allowed: false, canExecute: false, canDryRun: false,
      risk: { level: RISK_LEVELS.CRITICAL, score: 100, category: 'malformed' },
      findings: [], warnings: ['Malformed MCP tool input'], metadata: { adapterVersion: MCP_GATE_ADAPTER_VERSION },
    });
  }

  const { tool, args, metadata } = normalized;
  const classification = classifyMcpTool(tool);

  const findings = [];
  const warnings = [];
  const state = { decision: MCP_GATE_DECISIONS.allow, reason: MCP_GATE_REASONS.READ_ONLY_ALLOW, findings, warnings };

  if (!classification.known) {
    return buildDecision(MCP_GATE_DECISIONS.block, MCP_GATE_REASONS.UNKNOWN_TOOL_BLOCK, {
      ok: true, allowed: false, canExecute: false, canDryRun: false,
      risk: { level: RISK_LEVELS.CRITICAL, score: 100, category: 'unknown' },
      findings: [{ tool, known: false, decision: 'block' }],
      warnings: [`Unknown MCP tool: ${tool}`],
      metadata: { adapterVersion: MCP_GATE_ADAPTER_VERSION, tool, known: false },
    });
  }

  // Order matters: an earlier gate's block returns before a later gate runs.
  for (const [gate, run] of GATE_RUNNERS) {
    if (!classification.gates.includes(gate)) continue;
    const blocked = run(tool, args, metadata, state);
    if (blocked) return blocked;
  }
  let { decision, reason } = state;





  if (classification.alphaDecision === 'dry_run_only' && decision !== MCP_GATE_DECISIONS.block) {
    decision = mergeMcpDecisions(decision, MCP_GATE_DECISIONS.dry_run_only);
    if (decision === MCP_GATE_DECISIONS.dry_run_only) {
      reason = MCP_GATE_REASONS.AGENT_LOOP_DRY_RUN;
    }
  } else if (classification.alphaDecision === 'review' && decision !== MCP_GATE_DECISIONS.block) {
    decision = mergeMcpDecisions(decision, MCP_GATE_DECISIONS.review);
    if (decision === MCP_GATE_DECISIONS.review) {
      reason = MCP_GATE_REASONS.MUTATING_REVIEW;
    }
  }

  const riskLevel = { [MCP_GATE_DECISIONS.block]: RISK_LEVELS.CRITICAL, [MCP_GATE_DECISIONS.review]: RISK_LEVELS.MEDIUM }[decision] || RISK_LEVELS.LOW;
  // Preserve the highest bounded risk emitted by a real gate. The previous
  // review fallback of 50 erased AB1's HIGH signal and made downstream
  // critical-risk Human Oversight policy unreachable.
  const riskScore = Math.max(riskScoreForLevel(riskLevel), highestFindingRiskScore(findings));

  return {
    ok: true,
    allowed: decision === MCP_GATE_DECISIONS.allow,
    canExecute: decision === MCP_GATE_DECISIONS.allow,
    canDryRun: decision === MCP_GATE_DECISIONS.dry_run_only || decision === MCP_GATE_DECISIONS.review,
    decision,
    reason,
    risk: { level: riskLevelForScore(riskScore, RISK_LEVELS), score: riskScore, category: classification.category },
    requiredReview: decision === MCP_GATE_DECISIONS.review,
    dryRunOnly: decision === MCP_GATE_DECISIONS.dry_run_only,
    findings,
    warnings,
    // #2505 B: the verdict carries why it was reached, in the ledger's own
    // fields — including the allow, which previously carried no risk and no
    // reason. Recorded only; the decision above is untouched.
    justification: buildMcpJustification({
      score: riskScore,
      unknown: '',
      findings,
      reason,
      classification,
    }),
    metadata: {
      adapterVersion: MCP_GATE_ADAPTER_VERSION,
      tool,
      known: classification.known,
      mutating: classification.mutating,
      firewall: classification.gates.includes('AB5'),
    },
  };
}

module.exports = {
  MCP_GATE_ADAPTER_VERSION,
  MCP_TOOL_CLASSIFICATIONS,
  MCP_GATE_DECISIONS,
  MCP_GATE_REASONS,
  normalizeMcpToolInput,
  classifyMcpTool,
  mergeMcpDecisions,
  evaluateMcpGate,
};
