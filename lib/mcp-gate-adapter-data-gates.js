'use strict';

// MCP gate adapter, data gates (#2169): AB9 egress, AB11 cross-workspace and
// AB4 memory mutation, moved from mcp-gate-adapter.js.
// Each runner takes the shared { decision, reason, findings, warnings } state,
// merges its verdict into it, and returns a finished block decision when the
// gate blocks outright (the caller returns it unchanged). A gate error is
// recorded and fails closed through mergeMcpDecisions.

const { RISK_LEVELS } = require('./action-risk-classifier');
const { evaluateMemoryMutation, MEMORY_MUTATION_GATE_DECISIONS } = require('./memory-mutation-gate');
const { evaluateEgress } = require('./data-egress-gate');
const { evaluateCrossWorkspaceAccess, CROSS_WORKSPACE_DECISIONS } = require('./cross-workspace-access-gate');
const { toPercentRisk } = require('./risk-scale');
const { MCP_GATE_ADAPTER_VERSION, MCP_GATE_DECISIONS, MCP_GATE_REASONS } = require('./mcp-gate-adapter-contract');
const { buildDecision, mergeMcpDecisions, recordGateFailure } = require('./mcp-gate-adapter-decisions');
const { buildAb11Input, buildAb4Input, deriveMcpAction } = require('./mcp-gate-adapter-inputs');

function runAB9(tool, args, metadata, state) {
  const { findings, warnings } = state;
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
      state.decision = mergeMcpDecisions(state.decision, MCP_GATE_DECISIONS.review);
      state.reason = MCP_GATE_REASONS.AB9_EGRESS_REVIEW;
    }
  } catch (err) {
    state.decision = mergeMcpDecisions(state.decision, recordGateFailure('AB9', tool, err, findings, warnings));
    state.reason = MCP_GATE_REASONS.GATE_ERROR;
  }
}

function runAB11(tool, args, metadata, state) {
  const { findings, warnings } = state;
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
        state.decision = mergeMcpDecisions(state.decision, MCP_GATE_DECISIONS.review);
        state.reason = MCP_GATE_REASONS.AB11_CROSS_WORKSPACE_REVIEW;
      }
    }
  } catch (err) {
    state.decision = mergeMcpDecisions(state.decision, recordGateFailure('AB11', tool, err, findings, warnings));
    state.reason = MCP_GATE_REASONS.GATE_ERROR;
  }
}

// Driven by the table alone. The hardcoded `=== 'huqan.learn'` this replaces
// is what let ingest_execute advertise AB4 without running it: the list said
// one thing and the condition another. With the tool name gone, adding AB4 to
// a classification is the only thing needed to make it run (#1254).
function runAB4(tool, args, metadata, state) {
  const { findings, warnings } = state;
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
      state.decision = mergeMcpDecisions(state.decision, MCP_GATE_DECISIONS.review);
      state.reason = MCP_GATE_REASONS.AB4_BLOCKED;
    }
    if (ab4Result.decision === MEMORY_MUTATION_GATE_DECISIONS.DRY_RUN_ONLY) {
      state.decision = mergeMcpDecisions(state.decision, MCP_GATE_DECISIONS.dry_run_only);
      state.reason = MCP_GATE_REASONS.AB4_BLOCKED;
    }
  } catch (err) {
    state.decision = mergeMcpDecisions(state.decision, recordGateFailure('AB4', tool, err, findings, warnings));
    state.reason = MCP_GATE_REASONS.GATE_ERROR;
  }
}

module.exports = { runAB9, runAB11, runAB4 };
