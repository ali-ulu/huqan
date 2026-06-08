'use strict';

const { classifyAgentAction, ACTION_CATEGORIES, ACTION_DECISIONS, RISK_LEVELS, FLAGS } = require('./action-risk-classifier');
const { evaluateToolCall, TOOL_GATE_DECISIONS, TOOL_GATE_REASONS } = require('./tool-call-gate');
const { evaluateMemoryMutation, MEMORY_MUTATION_GATE_DECISIONS } = require('./memory-mutation-gate');
const { evaluateAutomationSafety, AUTOMATION_SAFETY_DECISIONS } = require('./automation-safety-gate');
const { evaluateSandboxIsolation, SANDBOX_ISOLATION_DECISIONS } = require('./sandbox-isolation');

const MCP_GATE_ADAPTER_VERSION = 'V2.6-PR1-v0.1.0';

const MCP_TOOL_CLASSIFICATIONS = Object.freeze({
  'axiom.ask': Object.freeze({ mutating: false, category: 'read', alphaDecision: 'allow', gates: ['AB1'] }),
  'axiom.verify': Object.freeze({ mutating: false, category: 'read', alphaDecision: 'allow', gates: ['AB1'] }),
  'axiom.plan': Object.freeze({ mutating: false, category: 'read', alphaDecision: 'allow', gates: ['AB1'] }),
  'axiom.policy': Object.freeze({ mutating: false, category: 'read', alphaDecision: 'allow', gates: ['AB1'] }),
  'axiom.approvals': Object.freeze({ mutating: false, category: 'read', alphaDecision: 'allow', gates: ['AB1'] }),
  'axiom.reason': Object.freeze({ mutating: false, category: 'read', alphaDecision: 'allow', gates: ['AB1'] }),
  'axiom.compare': Object.freeze({ mutating: false, category: 'read', alphaDecision: 'allow', gates: ['AB1'] }),
  'axiom.dream': Object.freeze({ mutating: false, category: 'read', alphaDecision: 'allow', gates: ['AB1'] }),
  'axiom.learn': Object.freeze({ mutating: true, category: 'write', alphaDecision: 'review', gates: ['AB1', 'AB2', 'AB4'] }),
  'axiom.agent': Object.freeze({ mutating: false, category: 'agent-loop', alphaDecision: 'dry_run_only', gates: ['AB1', 'AB2'] }),
});

const MCP_GATE_DECISIONS = Object.freeze({
  allow: 'allow',
  review: 'review',
  block: 'block',
  dry_run_only: 'dry_run_only',
  disabled: 'disabled',
});

const MCP_GATE_REASONS = Object.freeze({
  READ_ONLY_ALLOW: 'read_only_allow',
  MUTATING_REVIEW: 'mutating_requires_review',
  AGENT_LOOP_DRY_RUN: 'agent_loop_dry_run_only',
  UNKNOWN_TOOL_BLOCK: 'unknown_tool_blocked',
  AB1_BLOCKED: 'ab1_risk_classifier_blocked',
  AB2_BLOCKED: 'ab2_tool_call_gate_blocked',
  AB4_BLOCKED: 'ab4_memory_mutation_gate_blocked',
  AB5_BLOCKED: 'ab5_automation_safety_gate_blocked',
  AB6_BLOCKED: 'ab6_sandbox_isolation_gate_blocked',
  MALFORMED_INPUT: 'malformed_input_blocked',
  GATE_ERROR: 'gate_evaluation_error',
});

function normalizeMcpToolInput(input) {
  if (!input || typeof input !== 'object') {
    return { raw: input, tool: null, args: null, metadata: null, malformed: true };
  }
  const tool = typeof input.tool === 'string' ? input.tool.trim() : null;
  const args = input.args && typeof input.args === 'object' ? input.args : {};
  const metadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};
  return { raw: input, tool, args, metadata, malformed: !tool };
}

function classifyMcpTool(tool) {
  const classification = MCP_TOOL_CLASSIFICATIONS[tool];
  if (!classification) {
    return { known: false, mutating: true, category: 'unknown', alphaDecision: 'block', gates: ['AB1', 'AB2'] };
  }
  return { known: true, ...classification };
}

function buildAb1Input(tool, args, metadata) {
  const classification = classifyMcpTool(tool);
  let category;
  if (classification.category === 'read') {
    category = ACTION_CATEGORIES.READ_ONLY;
  } else if (classification.category === 'write') {
    category = ACTION_CATEGORIES.CANONICAL_GRAPH_WRITE;
  } else if (classification.category === 'agent-loop') {
    category = ACTION_CATEGORIES.TOOL_CHAIN_EXECUTION;
  } else {
    category = ACTION_CATEGORIES.READ_ONLY;
  }
  return {
    action: `mcp.${tool}`,
    category,
    target: tool,
    context: {
      source: 'mcp',
      args: JSON.stringify(args || {}).slice(0, 500),
      ...(metadata || {}),
    },
  };
}

function buildAb2Input(tool, args, ab1Result) {
  return {
    tool: `mcp.${tool}`,
    input: JSON.stringify(args || {}).slice(0, 500),
    action: ab1Result || undefined,
    dryRun: false,
  };
}

function buildAb4Input(tool, args) {
  return {
    entries: [{
      id: `mcp-${tool}-${Date.now()}`,
      action: 'learn',
      changeType: 'content',
      scope: 'graph',
      content: args?.text || '',
    }],
    operationType: 'learn',
    mutationType: 'graph',
    targetSpace: 'canonical',
  };
}

function buildAb5Input(tool, args, metadata) {
  return {
    operation: `mcp.${tool}`,
    operationType: 'tool-call',
    target: tool,
    actor: metadata?.actor || 'mcp-client',
    branch: metadata?.branch || 'main',
    baseBranch: metadata?.baseBranch || 'main',
  };
}

function buildAb6Input(tool, args, metadata) {
  return {
    source: metadata?.source || 'unknown',
    sourceTrust: metadata?.sourceTrust || 'unknown',
    runner: metadata?.runner || 'unknown',
    timeoutMs: metadata?.timeoutMs || 150,
    hasSnapshot: false,
    snapshotDepth: 0,
  };
}

function mergeMcpDecisions(current, requested) {
  const priority = { block: 4, dry_run_only: 3, review: 2, disabled: 1, allow: 0 };
  const currentPriority = priority[current] ?? 0;
  const requestedPriority = priority[requested] ?? 0;
  return requestedPriority >= currentPriority ? requested : current;
}

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
      warnings.push(`AB1 error: ${err.message}`);
    }
  }

  if (classification.gates.includes('AB2')) {
    try {
      const ab2Input = buildAb2Input(tool, args, findings.find(f => f.gate === 'AB1'));
      const ab2Result = evaluateToolCall(ab2Input);
      findings.push({ gate: 'AB2', tool, decision: ab2Result.decision });
      if (ab2Result.decision === TOOL_GATE_DECISIONS.block) {
        return buildDecision(MCP_GATE_DECISIONS.block, MCP_GATE_REASONS.AB2_BLOCKED, {
          ok: true, allowed: false, canExecute: false, canDryRun: ab2Result.canDryRun || false,
          risk: ab2Result.risk || { level: RISK_LEVELS.HIGH, score: 80, category: 'tool-call' },
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
      warnings.push(`AB2 error: ${err.message}`);
    }
  }

  if (classification.gates.includes('AB4') && tool === 'axiom.learn') {
    try {
      const ab4Input = buildAb4Input(tool, args);
      const ab4Result = evaluateMemoryMutation(ab4Input);
      findings.push({ gate: 'AB4', tool, decision: ab4Result.decision });
      if (ab4Result.decision === MEMORY_MUTATION_GATE_DECISIONS.block) {
        return buildDecision(MCP_GATE_DECISIONS.block, MCP_GATE_REASONS.AB4_BLOCKED, {
          ok: true, allowed: false, canExecute: false, canDryRun: ab4Result.canDryRun || false,
          risk: ab4Result.risk || { level: RISK_LEVELS.HIGH, score: 80, category: 'memory-mutation' },
          findings, warnings, metadata: { adapterVersion: MCP_GATE_ADAPTER_VERSION, tool, ab4Decision: ab4Result.decision },
        });
      }
      if (ab4Result.decision === MEMORY_MUTATION_GATE_DECISIONS.review || ab4Result.requiredReview) {
        decision = mergeMcpDecisions(decision, MCP_GATE_DECISIONS.review);
        reason = MCP_GATE_REASONS.AB4_BLOCKED;
      }
      if (ab4Result.decision === MEMORY_MUTATION_GATE_DECISIONS.dry_run_only) {
        decision = mergeMcpDecisions(decision, MCP_GATE_DECISIONS.dry_run_only);
        reason = MCP_GATE_REASONS.AB4_BLOCKED;
      }
    } catch (err) {
      warnings.push(`AB4 error: ${err.message}`);
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

  const riskLevel = decision === MCP_GATE_DECISIONS.block ? RISK_LEVELS.CRITICAL
    : decision === MCP_GATE_DECISIONS.review ? RISK_LEVELS.MEDIUM
    : decision === MCP_GATE_DECISIONS.dry_run_only ? RISK_LEVELS.LOW
    : RISK_LEVELS.LOW;

  return {
    ok: true,
    allowed: decision === MCP_GATE_DECISIONS.allow,
    canExecute: decision === MCP_GATE_DECISIONS.allow,
    canDryRun: decision === MCP_GATE_DECISIONS.dry_run_only || decision === MCP_GATE_DECISIONS.review,
    decision,
    reason,
    risk: { level: riskLevel, score: decision === MCP_GATE_DECISIONS.allow ? 0 : 50, category: classification.category },
    requiredReview: decision === MCP_GATE_DECISIONS.review,
    dryRunOnly: decision === MCP_GATE_DECISIONS.dry_run_only,
    findings,
    warnings,
    metadata: { adapterVersion: MCP_GATE_ADAPTER_VERSION, tool, known: classification.known, mutating: classification.mutating },
  };
}

function buildDecision(decision, reason, overrides = {}) {
  return {
    ok: true,
    allowed: decision === MCP_GATE_DECISIONS.allow,
    canExecute: decision === MCP_GATE_DECISIONS.allow,
    canDryRun: decision === MCP_GATE_DECISIONS.dry_run_only,
    decision,
    reason,
    risk: { level: RISK_LEVELS.LOW, score: 0, category: 'unknown' },
    requiredReview: false,
    dryRunOnly: false,
    findings: [],
    warnings: [],
    metadata: { adapterVersion: MCP_GATE_ADAPTER_VERSION },
    ...overrides,
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
