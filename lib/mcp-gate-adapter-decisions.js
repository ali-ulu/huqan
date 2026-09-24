'use strict';

// #2169: merging gate decisions (most restrictive wins), recording a gate
// that threw, and shaping the adapter's decision object.

const { RISK_LEVELS } = require('./action-risk-classifier');
const { riskLevelForScore } = require('./risk-scale');
const { MCP_GATE_ADAPTER_VERSION, MCP_GATE_DECISIONS } = require('./mcp-gate-adapter-contract');

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
    ...(overrides.risk ? { risk: { ...overrides.risk, level: riskLevelForScore(overrides.risk.score, RISK_LEVELS) ?? overrides.risk.level } } : {}),
  };
}

module.exports = {
  buildDecision,
  mergeMcpDecisions,
  recordGateFailure,
};
