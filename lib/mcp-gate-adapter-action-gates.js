'use strict';

// MCP gate adapter, action gates (#2169): AB1 classification, AB2 tool call,
// AB5 automation safety and AB8 command exec, moved from mcp-gate-adapter.js.
// Each runner takes the shared { decision, reason, findings, warnings } state,
// merges its verdict into it, and returns a finished block decision when the
// gate blocks outright (the caller returns it unchanged). A gate error is
// recorded and fails closed through mergeMcpDecisions.

const { classifyAgentAction, ACTION_DECISIONS, RISK_LEVELS } = require('./action-risk-classifier');
const { evaluateToolCall, TOOL_GATE_DECISIONS } = require('./tool-call-gate');
const { evaluateAutomationSafety, AUTOMATION_SAFETY_DECISIONS } = require('./automation-safety-gate');
const { evaluateCommandExec, COMMAND_EXEC_DECISIONS } = require('./command-exec-gate');
const { toPercentRisk } = require('./risk-scale');
const { MCP_GATE_ADAPTER_VERSION, MCP_GATE_DECISIONS, MCP_GATE_REASONS } = require('./mcp-gate-adapter-contract');
const { buildDecision, mergeMcpDecisions, recordGateFailure } = require('./mcp-gate-adapter-decisions');
const { buildAb1Input, buildAb2Input, buildAb5Input, buildAb8CommandText } = require('./mcp-gate-adapter-inputs');

function runAB1(tool, args, metadata, state) {
  const { findings, warnings } = state;
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
      state.decision = mergeMcpDecisions(state.decision, MCP_GATE_DECISIONS.review);
      state.reason = MCP_GATE_REASONS.AB1_BLOCKED;
    }
  } catch (err) {
    state.decision = mergeMcpDecisions(state.decision, recordGateFailure('AB1', tool, err, findings, warnings));
    state.reason = MCP_GATE_REASONS.GATE_ERROR;
  }
}

function runAB2(tool, args, metadata, state) {
  const { findings, warnings } = state;
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
      state.decision = mergeMcpDecisions(state.decision, MCP_GATE_DECISIONS.review);
      state.reason = MCP_GATE_REASONS.AB2_BLOCKED;
    }
    if (ab2Result.decision === TOOL_GATE_DECISIONS.dry_run_only) {
      state.decision = mergeMcpDecisions(state.decision, MCP_GATE_DECISIONS.dry_run_only);
      state.reason = MCP_GATE_REASONS.AB2_BLOCKED;
    }
  } catch (err) {
    state.decision = mergeMcpDecisions(state.decision, recordGateFailure('AB2', tool, err, findings, warnings));
    state.reason = MCP_GATE_REASONS.GATE_ERROR;
  }
}

function runAB5(tool, args, metadata, state) {
  const { findings, warnings } = state;
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
      state.decision = mergeMcpDecisions(state.decision, MCP_GATE_DECISIONS.review);
      state.reason = MCP_GATE_REASONS.AB5_BLOCKED;
    }
    if (ab5Result.decision === AUTOMATION_SAFETY_DECISIONS.DRY_RUN_ONLY) {
      state.decision = mergeMcpDecisions(state.decision, MCP_GATE_DECISIONS.dry_run_only);
      state.reason = MCP_GATE_REASONS.AB5_BLOCKED;
    }
  } catch (err) {
    state.decision = mergeMcpDecisions(state.decision, recordGateFailure('AB5', tool, err, findings, warnings));
    state.reason = MCP_GATE_REASONS.GATE_ERROR;
  }
}

function runAB8(tool, args, metadata, state) {
  const { findings, warnings } = state;
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
      state.decision = mergeMcpDecisions(state.decision, MCP_GATE_DECISIONS.review);
      state.reason = MCP_GATE_REASONS.AB8_REVIEW;
    }
  } catch (err) {
    state.decision = mergeMcpDecisions(state.decision, recordGateFailure('AB8', tool, err, findings, warnings));
    state.reason = MCP_GATE_REASONS.GATE_ERROR;
  }
}

module.exports = { runAB1, runAB2, runAB5, runAB8 };
