'use strict';

// The MCP gate adapter: runs one MCP tool call through every applicable gate
// (AB1..AB11) and merges their decisions, failing closed on a gate error.
// Contract, per-gate inputs and decision helpers live in mcp-gate-adapter-*.js (#2169).

const { classifyAgentAction, ACTION_DECISIONS, RISK_LEVELS } = require('./action-risk-classifier');
const { evaluateToolCall, TOOL_GATE_DECISIONS } = require('./tool-call-gate');
const { evaluateMemoryMutation, MEMORY_MUTATION_GATE_DECISIONS } = require('./memory-mutation-gate');
const { evaluateAutomationSafety, AUTOMATION_SAFETY_DECISIONS } = require('./automation-safety-gate');
const { evaluateCommandExec, COMMAND_EXEC_DECISIONS } = require('./command-exec-gate');
const { evaluateEgress } = require('./data-egress-gate');
const { evaluateCrossWorkspaceAccess, CROSS_WORKSPACE_DECISIONS } = require('./cross-workspace-access-gate');
const { toPercentRisk, riskLevelForScore } = require('./risk-scale');
const { MCP_GATE_ADAPTER_VERSION, MCP_GATE_DECISIONS, MCP_GATE_REASONS, MCP_TOOL_CLASSIFICATIONS, highestFindingRiskScore, riskScoreForLevel } = require('./mcp-gate-adapter-contract');
const { buildDecision, mergeMcpDecisions, recordGateFailure } = require('./mcp-gate-adapter-decisions');
const { buildAb11Input, buildAb1Input, buildAb2Input, buildAb4Input, buildAb5Input, buildAb8CommandText, classifyMcpTool, deriveMcpAction, normalizeMcpToolInput } = require('./mcp-gate-adapter-inputs');

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

  let decision = MCP_GATE_DECISIONS.allow;
  let reason = MCP_GATE_REASONS.READ_ONLY_ALLOW;
  const findings = [];
  const warnings = [];

  if (!classification.known) {
    return buildDecision(MCP_GATE_DECISIONS.block, MCP_GATE_REASONS.UNKNOWN_TOOL_BLOCK, {
      ok: true, allowed: false, canExecute: false, canDryRun: false,
      risk: { level: RISK_LEVELS.CRITICAL, score: 100, category: 'unknown' },
      findings: [{ tool, known: false, decision: 'block' }],
      warnings: [`Unknown MCP tool: ${tool}`],
      metadata: { adapterVersion: MCP_GATE_ADAPTER_VERSION, tool, known: false },
    });
  }

  if (classification.gates.includes('AB1')) {
    try {
      const ab1Input = buildAb1Input(tool, args, metadata);
      const ab1Result = classifyAgentAction(ab1Input);
      findings.push({ gate: 'AB1', tool, decision: ab1Result.decision, riskLevel: ab1Result.riskLevel });
      if (ab1Result.decision === ACTION_DECISIONS.BLOCK) {
        return buildDecision(MCP_GATE_DECISIONS.block, MCP_GATE_REASONS.AB1_BLOCKED, {
          ok: true, allowed: false, canExecute: false, canDryRun: false,
          risk: { level: ab1Result.riskLevel, score: 100, category: ab1Result.category },
          findings, warnings, metadata: { adapterVersion: MCP_GATE_ADAPTER_VERSION, tool, ab1Decision: ab1Result.decision },
        });
      }
      if (ab1Result.requiredReview || ab1Result.decision === ACTION_DECISIONS.QUARANTINE || ab1Result.decision === ACTION_DECISIONS.HUMAN_REVIEW) {
        decision = mergeMcpDecisions(decision, MCP_GATE_DECISIONS.review);
        reason = MCP_GATE_REASONS.AB1_BLOCKED;
      }
    } catch (err) {
      decision = mergeMcpDecisions(decision, recordGateFailure('AB1', tool, err, findings, warnings));
      reason = MCP_GATE_REASONS.GATE_ERROR;
    }
  }

  if (classification.gates.includes('AB2')) {
    try {
      const ab2Input = buildAb2Input(tool, args, findings.find(f => f.gate === 'AB1'));
      const ab2Result = evaluateToolCall(ab2Input);
      // AB7: record why AB2 decided this (e.g. SECRET_ARGS_REVIEW_REQUIRED)
      // without ever including the raw args/secret value itself in the
      // findings chain.
      findings.push({ gate: 'AB2', tool, decision: ab2Result.decision, reason: ab2Result.reason });
      if (ab2Result.decision === TOOL_GATE_DECISIONS.block) {
        return buildDecision(MCP_GATE_DECISIONS.block, MCP_GATE_REASONS.AB2_BLOCKED, {
          ok: true, allowed: false, canExecute: false, canDryRun: ab2Result.canDryRun || false,
          risk: toPercentRisk(ab2Result.risk, 'AB2') || { level: RISK_LEVELS.HIGH, score: 80, category: 'tool-call' },
          findings, warnings, metadata: { adapterVersion: MCP_GATE_ADAPTER_VERSION, tool, ab2Decision: ab2Result.decision },
        });
      }
      if (ab2Result.decision === TOOL_GATE_DECISIONS.review || ab2Result.requiredReview) {
        decision = mergeMcpDecisions(decision, MCP_GATE_DECISIONS.review);
        reason = MCP_GATE_REASONS.AB2_BLOCKED;
      }
      if (ab2Result.decision === TOOL_GATE_DECISIONS.dry_run_only) {
        decision = mergeMcpDecisions(decision, MCP_GATE_DECISIONS.dry_run_only);
        reason = MCP_GATE_REASONS.AB2_BLOCKED;
      }
    } catch (err) {
      decision = mergeMcpDecisions(decision, recordGateFailure('AB2', tool, err, findings, warnings));
      reason = MCP_GATE_REASONS.GATE_ERROR;
    }
  }

  if (classification.gates.includes('AB5')) {
    try {
      const ab5Result = evaluateAutomationSafety(buildAb5Input(tool, args, metadata));
      findings.push({
        gate: 'AB5',
        tool,
        decision: ab5Result.decision,
        reason: ab5Result.reason,
        risk: toPercentRisk(ab5Result.risk, 'AB5') || ab5Result.risk,
        categories: ab5Result.risk?.categories || [],
      });
      if (ab5Result.decision === AUTOMATION_SAFETY_DECISIONS.BLOCK) {
        return buildDecision(MCP_GATE_DECISIONS.block, MCP_GATE_REASONS.AB5_BLOCKED, {
          ok: true, allowed: false, canExecute: false, canDryRun: ab5Result.canDryRun || false,
          risk: toPercentRisk(ab5Result.risk, 'AB5') || { level: RISK_LEVELS.CRITICAL, score: 100, category: 'automation-safety' },
          findings, warnings,
          metadata: {
            adapterVersion: MCP_GATE_ADAPTER_VERSION,
            tool,
            ab5Decision: ab5Result.decision,
            ab5Reason: ab5Result.reason,
            ab5ActionId: ab5Result.metadata?.actionId || null,
            firewallVersion: ab5Result.metadata?.firewallVersion || null,
          },
        });
      }
      if (ab5Result.decision === AUTOMATION_SAFETY_DECISIONS.REVIEW || ab5Result.requiredReview) {
        decision = mergeMcpDecisions(decision, MCP_GATE_DECISIONS.review);
        reason = MCP_GATE_REASONS.AB5_BLOCKED;
      }
      if (ab5Result.decision === AUTOMATION_SAFETY_DECISIONS.DRY_RUN_ONLY) {
        decision = mergeMcpDecisions(decision, MCP_GATE_DECISIONS.dry_run_only);
        reason = MCP_GATE_REASONS.AB5_BLOCKED;
      }
    } catch (err) {
      decision = mergeMcpDecisions(decision, recordGateFailure('AB5', tool, err, findings, warnings));
      reason = MCP_GATE_REASONS.GATE_ERROR;
    }
  }

  if (classification.gates.includes('AB8')) {
    try {
      const commandText = buildAb8CommandText(tool, args);
      const ab8Result = evaluateCommandExec({ command: commandText });
      // AB8: record the decision/reason and any denylist/injection/path
      // finding names -- never the raw command text itself -- so the
      // findings chain stays evidence-bearing without echoing what may be
      // an attacker-supplied command string back into stored audit data.
      findings.push({
        gate: 'AB8',
        tool,
        decision: ab8Result.decision,
        reason: ab8Result.reason,
        denylistMatch: ab8Result.denylistMatch,
        injectionMatches: ab8Result.injectionMatches,
      });
      if (ab8Result.decision === COMMAND_EXEC_DECISIONS.BLOCK) {
        return buildDecision(MCP_GATE_DECISIONS.block, MCP_GATE_REASONS.AB8_BLOCKED, {
          ok: true, allowed: false, canExecute: false, canDryRun: false,
          risk: { level: RISK_LEVELS.CRITICAL, score: 95, category: 'command-exec' },
          findings, warnings, metadata: { adapterVersion: MCP_GATE_ADAPTER_VERSION, tool, ab8Decision: ab8Result.decision },
        });
      }
      if (ab8Result.decision === COMMAND_EXEC_DECISIONS.REVIEW && commandText) {
        decision = mergeMcpDecisions(decision, MCP_GATE_DECISIONS.review);
        reason = MCP_GATE_REASONS.AB8_REVIEW;
      }
    } catch (err) {
      decision = mergeMcpDecisions(decision, recordGateFailure('AB8', tool, err, findings, warnings));
      reason = MCP_GATE_REASONS.GATE_ERROR;
    }
  }

  if (classification.gates.includes('AB9')) {
    try {
      const egress = evaluateEgress(args);
      // AB9: record what kind of PII was found (never the matched value
      // itself) plus whether AB7's secret detector also fired, so the
      // findings chain stays evidence-bearing without leaking the payload.
      findings.push({
        gate: 'AB9',
        tool,
        piiDetected: egress.piiDetected,
        piiTypes: egress.piiTypes,
        secretDetected: egress.secretDetected,
      });
      if (egress.piiDetected || egress.secretDetected) {
        decision = mergeMcpDecisions(decision, MCP_GATE_DECISIONS.review);
        reason = MCP_GATE_REASONS.AB9_EGRESS_REVIEW;
      }
    } catch (err) {
      decision = mergeMcpDecisions(decision, recordGateFailure('AB9', tool, err, findings, warnings));
      reason = MCP_GATE_REASONS.GATE_ERROR;
    }
  }

  if (classification.gates.includes('AB11')) {
    try {
      const ab11Input = buildAb11Input({ ...args, operation: deriveMcpAction(tool, args) }, metadata);
      if (ab11Input) {
        const ab11Result = evaluateCrossWorkspaceAccess(ab11Input);
        findings.push({
          gate: 'AB11',
          tool,
          decision: ab11Result.decision,
          reason: ab11Result.reason,
          crossWorkspace: ab11Result.crossWorkspace,
        });

        if (ab11Result.decision === CROSS_WORKSPACE_DECISIONS.BLOCK) {
          return buildDecision(MCP_GATE_DECISIONS.block, MCP_GATE_REASONS.AB11_CROSS_WORKSPACE_BLOCKED, {
            ok: true, allowed: false, canExecute: false, canDryRun: false,
            risk: { level: RISK_LEVELS.CRITICAL, score: 95, category: 'cross-workspace' },
            findings, warnings,
            metadata: { adapterVersion: MCP_GATE_ADAPTER_VERSION, tool, ab11Decision: ab11Result.decision },
          });
        }
        if (ab11Result.decision === CROSS_WORKSPACE_DECISIONS.REVIEW) {
          decision = mergeMcpDecisions(decision, MCP_GATE_DECISIONS.review);
          reason = MCP_GATE_REASONS.AB11_CROSS_WORKSPACE_REVIEW;
        }
      }
    } catch (err) {
      decision = mergeMcpDecisions(decision, recordGateFailure('AB11', tool, err, findings, warnings));
      reason = MCP_GATE_REASONS.GATE_ERROR;
    }
  }

  // Driven by the table alone. The hardcoded `=== 'huqan.learn'` this replaces
  // is what let ingest_execute advertise AB4 without running it: the list said
  // one thing and the condition another. With the tool name gone, adding AB4 to
  // a classification is the only thing needed to make it run (#1254).
  if (classification.gates.includes('AB4')) {
    try {
      const ab4Input = buildAb4Input(tool, args);
      const ab4Result = evaluateMemoryMutation(ab4Input);
      findings.push({ gate: 'AB4', tool, action: ab4Input.entries[0].action, decision: ab4Result.decision });
      if (ab4Result.decision === MEMORY_MUTATION_GATE_DECISIONS.BLOCK) {
        return buildDecision(MCP_GATE_DECISIONS.block, MCP_GATE_REASONS.AB4_BLOCKED, {
          ok: true, allowed: false, canExecute: false, canDryRun: ab4Result.canDryRun || false,
          risk: toPercentRisk(ab4Result.risk, 'AB4') || { level: RISK_LEVELS.HIGH, score: 80, category: 'memory-mutation' },
          findings, warnings, metadata: { adapterVersion: MCP_GATE_ADAPTER_VERSION, tool, ab4Decision: ab4Result.decision },
        });
      }
      if (ab4Result.decision === MEMORY_MUTATION_GATE_DECISIONS.REVIEW || ab4Result.requiredReview) {
        decision = mergeMcpDecisions(decision, MCP_GATE_DECISIONS.review);
        reason = MCP_GATE_REASONS.AB4_BLOCKED;
      }
      if (ab4Result.decision === MEMORY_MUTATION_GATE_DECISIONS.DRY_RUN_ONLY) {
        decision = mergeMcpDecisions(decision, MCP_GATE_DECISIONS.dry_run_only);
        reason = MCP_GATE_REASONS.AB4_BLOCKED;
      }
    } catch (err) {
      decision = mergeMcpDecisions(decision, recordGateFailure('AB4', tool, err, findings, warnings));
      reason = MCP_GATE_REASONS.GATE_ERROR;
    }
  }

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
