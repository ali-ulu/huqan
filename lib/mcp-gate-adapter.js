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
const { gateSignalProviderForKernel } = require('./gate-signal-provider');

const GATE_RUNNERS = Object.freeze([
  ['AB1', runAB1], ['AB2', runAB2], ['AB5', runAB5], ['AB8', runAB8],
  ['AB9', runAB9], ['AB11', runAB11], ['AB4', runAB4],
]);

// Each plugin's beforeGateDecision signal enters the decision as independent
// evidence (never as a replacement for tool/args/metadata). This is the core
// mechanism; the AURA loop's rule hardening rides on the signal provider below.
function collectPluginFindings(plugins, input) {
  if (!plugins || typeof plugins.collectEvidence !== 'function') return [];
  return plugins.collectEvidence('beforeGateDecision', input).flatMap(({ plugin, signal, failed }) => {
    if (!failed && signal === undefined) return [];
    const valid = !failed && signal && typeof signal === 'object' && !Array.isArray(signal)
      && ['allow', 'review', 'dry_run_only', 'block'].includes(signal.decision);
    return [{
      gate: 'beforeGateDecision',
      tool: input.tool,
      plugin,
      decision: valid ? signal.decision : MCP_GATE_DECISIONS.block,
      reason: valid ? 'plugin_gate_evidence' : 'plugin_gate_evidence_error',
      ...(!valid ? { failClosed: true } : {}),
    }];
  });
}

// The signal provider is opt-in and adds what the plugin findings alone cannot:
// the active error-prevention rules a kernel carries (lib/gate-signal-provider.js),
// so a rule learned from a blind spot hardens the *live* gate, not only the
// SDK's preflight. Callers that hold a kernel pass it; callers that do not
// (pure gate unit tests, tooling with no kernel) get the adapter's own gates
// only, exactly as before — so this seam adds a path to escalate a decision,
// never a new way to reach `allow`.
function resolveSignalProvider(options = {}) {
  if (typeof options.signalProvider === 'function') return options.signalProvider;
  if (options.kernel) return gateSignalProviderForKernel(options.kernel, { workspaceId: options.workspaceId });
  return null;
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

  // Plugins see the evaluated text before core gates run, but only their
  // independent evidence enters the decision. Never replace tool/args/metadata.
  const pluginFindings = collectPluginFindings(options.plugins, { tool, args, metadata });
  findings.push(...pluginFindings);

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

  for (const finding of pluginFindings) {
    const merged = mergeMcpDecisions(decision, finding.decision);
    if (merged !== decision) reason = finding.reason;
    decision = merged;
  }

  const riskLevelFor = (d) => ({ [MCP_GATE_DECISIONS.block]: RISK_LEVELS.CRITICAL, [MCP_GATE_DECISIONS.review]: RISK_LEVELS.MEDIUM }[d] || RISK_LEVELS.LOW);

  // The signal provider contributes evidence, not a verdict: its decision is
  // merged with the gates' (most restrictive wins) and its findings join the
  // ones the risk score is taken from. Merging can only raise the decision, so
  // a provider can escalate a call the gates would have allowed but can never
  // lower one they would have stopped.
  const provider = resolveSignalProvider(options);
  if (provider) {
    const provided = provider({ tool, args, metadata });
    if (provided && typeof provided === 'object') {
      if (Array.isArray(provided.findings)) findings.push(...provided.findings);
      const merged = mergeMcpDecisions(decision, provided.decision);
      if (merged !== decision) {
        decision = merged;
        reason = provided.reason || MCP_GATE_REASONS.SIGNAL_REVIEW;
      }
    }
  }

  // Preserve the highest bounded risk emitted by a real gate. The previous
  // review fallback of 50 erased AB1's HIGH signal and made downstream
  // critical-risk Human Oversight policy unreachable.
  const mergedRiskLevel = riskLevelFor(decision);
  const riskScore = Math.max(riskScoreForLevel(mergedRiskLevel), highestFindingRiskScore(findings));

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
