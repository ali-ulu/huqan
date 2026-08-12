'use strict';

const { classifyAgentAction, ACTION_CATEGORIES, ACTION_DECISIONS, RISK_LEVELS, FLAGS } = require('./action-risk-classifier');
const { evaluateToolCall, TOOL_GATE_DECISIONS, TOOL_GATE_REASONS } = require('./tool-call-gate');
const { evaluateMemoryMutation, MEMORY_MUTATION_GATE_DECISIONS } = require('./memory-mutation-gate');
const { evaluateAutomationSafety, AUTOMATION_SAFETY_DECISIONS } = require('./automation-safety-gate');
const { evaluateSandboxIsolation, SANDBOX_ISOLATION_DECISIONS } = require('./sandbox-isolation');
const { evaluateCommandExec, COMMAND_EXEC_DECISIONS } = require('./command-exec-gate');
const { evaluateEgress } = require('./data-egress-gate');
const { evaluateCrossWorkspaceAccess, CROSS_WORKSPACE_DECISIONS } = require('./cross-workspace-access-gate');
const { canonicalMcpToolName } = require('./mcp-tool-names');

const MCP_GATE_ADAPTER_VERSION = 'V2.6-PR1-v0.1.0';

/**
 * Keyed on the RFC-001 canonical `huqan.*` names. `classifyMcpTool` resolves the
 * deprecated `axiom.*` aliases through `canonicalMcpToolName` first, so a legacy
 * call is classified — and therefore gated — identically to a canonical one. The
 * gate is not a place where the two spellings may diverge.
 */
const MCP_TOOL_CLASSIFICATIONS = Object.freeze({
  'huqan.ask': Object.freeze({ mutating: false, category: 'read', alphaDecision: 'allow', gates: ['AB1', 'AB11'] }),
  'huqan.verify': Object.freeze({ mutating: false, category: 'read', alphaDecision: 'allow', gates: ['AB1', 'AB11'] }),
  'huqan.plan': Object.freeze({ mutating: false, category: 'read', alphaDecision: 'allow', gates: ['AB1', 'AB11'] }),
  'huqan.policy': Object.freeze({ mutating: false, category: 'read', alphaDecision: 'allow', gates: ['AB1', 'AB11'] }),
  'huqan.approvals': Object.freeze({ mutating: false, category: 'read', alphaDecision: 'allow', gates: ['AB1', 'AB11'] }),
  'huqan.reason': Object.freeze({ mutating: false, category: 'read', alphaDecision: 'allow', gates: ['AB1', 'AB11'] }),
  'huqan.compare': Object.freeze({ mutating: false, category: 'read', alphaDecision: 'allow', gates: ['AB1', 'AB11'] }),
  'huqan.dream': Object.freeze({ mutating: false, category: 'read', alphaDecision: 'allow', gates: ['AB1', 'AB11'] }),
  'huqan.learn': Object.freeze({ mutating: true, category: 'write', alphaDecision: 'review', gates: ['AB1', 'AB2', 'AB4', 'AB11'] }),
  'huqan.agent': Object.freeze({ mutating: false, category: 'agent-loop', alphaDecision: 'dry_run_only', gates: ['AB1', 'AB2', 'AB8', 'AB9', 'AB11'] }),
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
  AB8_BLOCKED: 'ab8_command_exec_gate_blocked',
  AB8_REVIEW: 'ab8_command_exec_review_required',
  AB9_EGRESS_REVIEW: 'ab9_data_egress_review_required',
  AB11_CROSS_WORKSPACE_BLOCKED: 'ab11_cross_workspace_access_blocked',
  AB11_CROSS_WORKSPACE_REVIEW: 'ab11_cross_workspace_access_review_required',
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
  const classification = MCP_TOOL_CLASSIFICATIONS[canonicalMcpToolName(tool)];
  if (!classification) {
    // Unknown tools are blocked before any gate runs, so this list is
    // informational; left unchanged rather than grown for appearance.
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

function deriveMcpAction(tool, args) {
  if (isPlainObject(args)) {
    for (const key of ['action', 'operation', 'mode', 'intent', 'kind', 'type']) {
      if (typeof args[key] === 'string' && args[key].trim()) return args[key].trim();
    }
  }
  return typeof tool === 'string' ? tool.split('.').pop() : '';
}

function buildAb4Input(tool, args) {
  const action = deriveMcpAction(tool, args);
  const workspaceId = isPlainObject(args) && typeof args.workspaceId === 'string' && args.workspaceId.trim()
    ? args.workspaceId.trim()
    : 'default';
  return {
    entries: [{
      id: `mcp-${tool}-${Date.now()}`,
      action,
      changeType: 'content',
      scope: workspaceId,
      workspaceId,
      content: args?.text || '',
    }],
    operationType: action,
    mutationType: 'graph',
    targetSpace: workspaceId,
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

/**
 * AB8 only has one real command-bearing surface today: huqan.agent's free-text
 * `goal`, which an agent loop could plausibly turn into a literal shell
 * command. This pulls out the same command-shaped fields command-exec-gate
 * itself recognizes (command/cmd/shell/script/exec), falling back to `goal`
 * since that is the field huqan.agent actually declares.
 */
function buildAb8CommandText(tool, args) {
  if (!isPlainObject(args)) return '';
  return String(args.command ?? args.cmd ?? args.shell ?? args.script ?? args.exec ?? args.goal ?? '');
}

/**
 * AB11 only has something to decide when a call actually expresses a
 * cross-workspace intent: metadata names the workspace the caller operates
 * in, and args name a different workspace to act on.
 *
 * When a call declares no workspace at all it is not making a cross-workspace
 * claim, and this adapter deliberately does not invent one. Requiring every
 * MCP caller to declare a workspace would be a breaking interface change and
 * belongs to its own decision, not to a gate wiring.
 */
function buildAb11Input(args, metadata) {
  const actorWorkspaceId = isPlainObject(metadata) ? metadata.workspaceId : undefined;
  const targetWorkspaceId = isPlainObject(args) ? args.workspaceId : undefined;
  const declared = typeof actorWorkspaceId === 'string' && actorWorkspaceId.trim()
    && typeof targetWorkspaceId === 'string' && targetWorkspaceId.trim();

  if (!declared) return null;

  return {
    actorWorkspaceId,
    targetWorkspaceId,
    operation: deriveMcpAction('', args),
    grants: isPlainObject(metadata) && Array.isArray(metadata.workspaceGrants) ? metadata.workspaceGrants : [],
    resourceType: 'mcp-tool',
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergeMcpDecisions(current, requested) {
  const priority = { block: 4, dry_run_only: 3, review: 2, disabled: 1, allow: 0 };
  const currentPriority = priority[current] ?? 0;
  const requestedPriority = priority[requested] ?? 0;
  return requestedPriority >= currentPriority ? requested : current;
}

/**
 * #358: a gate that throws must fail closed, not fail open. Each gate below
 * used to run inside try/catch blocks that only pushed a warning string on
 * error -- `decision` was left untouched, which defaulted to 'allow' for any
 * tool whose alphaDecision starts at allow (every read-only tool, plus any
 * gate that runs before the first one that would have escalated it). Malformed
 * or unexpectedly-shaped args crafted to make a specific gate throw would
 * silently skip that gate's check entirely instead of being blocked.
 *
 * Called from every gate's catch block. Escalates `decision` to `block`
 * (mergeMcpDecisions is monotonic, so this can never be downgraded by a
 * later gate) and records a findings entry, so a gate failure is visible in
 * the audit trail the same way a real BLOCK decision is -- not just a
 * warning string that a caller could plausibly ignore.
 */
function recordGateFailure(gateName, tool, err, findings, warnings) {
  const message = err && typeof err.message === 'string' ? err.message : String(err);
  warnings.push(`${gateName} error: ${message}`);
  findings.push({ gate: gateName, tool, error: message, decision: MCP_GATE_DECISIONS.block, failClosed: true });
  return MCP_GATE_DECISIONS.block;
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
      decision = mergeMcpDecisions(decision, recordGateFailure('AB2', tool, err, findings, warnings));
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

  if (classification.gates.includes('AB4') && canonicalMcpToolName(tool) === 'huqan.learn') {
    try {
      const ab4Input = buildAb4Input(tool, args);
      const ab4Result = evaluateMemoryMutation(ab4Input);
      findings.push({ gate: 'AB4', tool, action: ab4Input.entries[0].action, decision: ab4Result.decision });
      if (ab4Result.decision === MEMORY_MUTATION_GATE_DECISIONS.BLOCK) {
        return buildDecision(MCP_GATE_DECISIONS.block, MCP_GATE_REASONS.AB4_BLOCKED, {
          ok: true, allowed: false, canExecute: false, canDryRun: ab4Result.canDryRun || false,
          risk: ab4Result.risk || { level: RISK_LEVELS.HIGH, score: 80, category: 'memory-mutation' },
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
