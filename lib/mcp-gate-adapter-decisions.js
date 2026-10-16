'use strict';

// #2169: merging gate decisions (most restrictive wins), recording a gate
// that threw, and shaping the adapter's decision object.

const { RISK_LEVELS } = require('./action-risk-classifier');
const { RISK_LEVEL_BANDS, riskLevelForScore } = require('./risk-scale');
const { normalizeJustification } = require('./trust-evidence-ledger');
const { MCP_GATE_ADAPTER_VERSION, MCP_GATE_DECISIONS } = require('./mcp-gate-adapter-contract');

// #2505 B: the level bands the verdict's risk level is derived from. Derived
// from the canonical bands (not copied) so the recorded thresholds cannot
// drift from the ones that applied. LOW has no floor above zero to record.
const MCP_JUSTIFICATION_THRESHOLDS = Object.freeze(Object.fromEntries(
  RISK_LEVEL_BANDS.filter(([floor]) => floor > 0)
    .map(([floor, level]) => [`${String(level).toLowerCase()}At`, floor]),
));

const MAX_JUSTIFICATION_DIMENSIONS = 16;

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
  const risk = overrides.risk;
  const scored = risk && typeof risk.score === 'number' && Number.isFinite(risk.score)
    && risk.score >= 0 && risk.score <= 100;
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
    // #2505 B: every verdict carries why it was reached, in the same fields
    // the trust evidence ledger records. Derived from the verdict's own
    // inputs, never asserted by the caller. Unknown is never 0: without an
    // assessed score the verdict says so instead of reading as harmless.
    justification: buildMcpJustification({
      score: scored ? risk.score : null,
      unknown: scored ? '' : 'risk-not-assessed',
      findings: Array.isArray(overrides.findings) ? overrides.findings : [],
      reason,
    }),
  };
}

/**
 * #2505 B: shape an MCP verdict's justification with the ledger's own
 * validation, so both surfaces carry the same fields under the same rules.
 * `findings` are the gate inputs the score came from; `reason` is the
 * fallback dimension when a verdict carries no findings of its own.
 */
function buildMcpJustification({ score, unknown, findings = [], reason = '', classification = null }) {
  const dimensions = [];
  if (classification && typeof classification === 'object') {
    if (classification.category !== undefined) {
      dimensions.push({ dimension: 'tool-category', value: String(classification.category), source: 'mcp-tool-classification' });
    }
    for (const key of ['known', 'mutating']) {
      if (classification[key] !== undefined) {
        dimensions.push({ dimension: `tool-${key}`, value: Boolean(classification[key]), source: 'mcp-tool-classification' });
      }
    }
  }
  for (const finding of findings) {
    if (dimensions.length >= MAX_JUSTIFICATION_DIMENSIONS) break;
    if (!finding || typeof finding !== 'object') continue;
    dimensions.push({
      dimension: `gate:${finding.gate || 'unknown'}`,
      value: finding.decision === undefined ? null : String(finding.decision),
      source: 'mcp-gate-adapter',
    });
  }
  if (!dimensions.length && reason) {
    dimensions.push({ dimension: 'decision-reason', value: String(reason), source: 'mcp-gate-adapter' });
  }
  return normalizeJustification({
    score,
    unknown,
    dimensions: dimensions.slice(0, MAX_JUSTIFICATION_DIMENSIONS),
    thresholds: { ...MCP_JUSTIFICATION_THRESHOLDS },
  });
}

module.exports = {
  MCP_JUSTIFICATION_THRESHOLDS,
  buildDecision,
  buildMcpJustification,
  mergeMcpDecisions,
  recordGateFailure,
};
