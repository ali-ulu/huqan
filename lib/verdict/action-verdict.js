'use strict';

/**
 * V4-PR2 — Unified Verdict Reconciliation.
 *
 * This module does NOT change what any existing gate decides. It is a thin,
 * additive projection layer: it reads the decision objects already produced
 * by lib/memory-admission-gate.js (evaluateMemoryAdmission) and
 * lib/mcp-gate-adapter.js (evaluateMcpGate) and maps their existing decision
 * strings onto one canonical product verdict.
 *
 * Per docs/v4/verdict-reconciliation.md: `require_approval` is intentionally
 * NOT a canonical runtime verdict. `review` remains the runtime verdict;
 * `require_approval` is a UI-facing label layered on top of `review` via
 * classifyForUi(), not a distinct decision value.
 */

// The single canonical verdict set every gate's decision projects onto.
const CANONICAL_VERDICTS = Object.freeze([
  'allow',
  'review',
  'block',
  'dry_run_only',
  'quarantine',
  'disabled',
]);

const CANONICAL_VERDICT_SET = new Set(CANONICAL_VERDICTS);

// Mapping table from docs/v4/verdict-reconciliation.md §2. Do not add a value
// here without a corresponding row in that document.
const ADMISSION_TO_CANONICAL = Object.freeze({
  allow: 'allow',
  review: 'review',
  reject: 'block',
  quarantine: 'quarantine',
});

const MCP_TO_CANONICAL = Object.freeze({
  allow: 'allow',
  review: 'review',
  block: 'block',
  dry_run_only: 'dry_run_only',
  disabled: 'disabled',
});

class UnknownVerdictSourceError extends Error {
  constructor(sourceLayer, sourceDecision) {
    super(`Unknown ${sourceLayer} decision value: ${JSON.stringify(sourceDecision)}. Refusing to guess a canonical verdict.`);
    this.name = 'UnknownVerdictSourceError';
    this.code = 'UNKNOWN_VERDICT_SOURCE';
    this.sourceLayer = sourceLayer;
    this.sourceDecision = sourceDecision;
  }
}

function toCanonicalVerdict(sourceLayer, sourceDecisionValue) {
  const table = sourceLayer === 'admission' ? ADMISSION_TO_CANONICAL
    : sourceLayer === 'mcp' ? MCP_TO_CANONICAL
    : null;
  if (!table) {
    throw new UnknownVerdictSourceError(sourceLayer, sourceDecisionValue);
  }
  const canonical = table[sourceDecisionValue];
  if (!canonical) {
    // Fail closed: an unrecognized decision string must never silently
    // resolve to 'allow'. This is a mapping bug, not a runtime risk decision.
    throw new UnknownVerdictSourceError(sourceLayer, sourceDecisionValue);
  }
  return canonical;
}

/**
 * Build a canonical verdict envelope from a real evaluateMemoryAdmission()
 * decision object (lib/memory-admission-gate.js). Does not re-evaluate
 * anything; only projects the existing decision.
 */
function fromAdmissionDecision(decision) {
  if (!decision || typeof decision !== 'object') {
    throw new TypeError('fromAdmissionDecision requires an admission decision object');
  }
  return Object.freeze({
    verdict: toCanonicalVerdict('admission', decision.decision),
    sourceLayer: 'admission',
    sourceDecision: decision.decision,
    reason: decision.reason || '',
    risk: decision.risk ? { level: decision.risk.level, score: decision.risk.score } : null,
    actor: decision.actor || '',
    workspaceId: decision.workspaceId || 'default',
    receiptId: decision.receiptId || '',
    metadata: decision.metadata ? { ...decision.metadata } : {},
  });
}

/**
 * Build a canonical verdict envelope from a real evaluateMcpGate() decision
 * object (lib/mcp-gate-adapter.js). Does not re-evaluate anything; only
 * projects the existing decision.
 */
function fromMcpDecision(decision) {
  if (!decision || typeof decision !== 'object') {
    throw new TypeError('fromMcpDecision requires an MCP gate decision object');
  }
  return Object.freeze({
    verdict: toCanonicalVerdict('mcp', decision.decision),
    sourceLayer: 'mcp',
    sourceDecision: decision.decision,
    reason: decision.reason || '',
    risk: decision.risk ? { level: decision.risk.level, score: decision.risk.score } : null,
    actor: '',
    workspaceId: 'default',
    receiptId: '',
    metadata: decision.metadata ? { ...decision.metadata } : {},
  });
}

/**
 * UI-facing classification layered on top of a canonical envelope.
 * `require_approval` is intentionally NOT part of CANONICAL_VERDICTS — it is
 * copy/classification for a `review` verdict, per
 * docs/v4/verdict-reconciliation.md §3 (Option A).
 */
function classifyForUi(envelope) {
  if (!envelope || typeof envelope !== 'object') {
    throw new TypeError('classifyForUi requires a canonical verdict envelope');
  }
  if (envelope.verdict === 'review') return 'require_approval';
  return envelope.verdict;
}

/** Serialize a canonical envelope to a plain JSON-safe object (schema shape). */
function serializeVerdict(envelope) {
  if (!envelope || typeof envelope !== 'object') {
    throw new TypeError('serializeVerdict requires a canonical verdict envelope');
  }
  return JSON.parse(JSON.stringify({
    verdict: envelope.verdict,
    sourceLayer: envelope.sourceLayer,
    sourceDecision: envelope.sourceDecision,
    reason: envelope.reason || '',
    risk: envelope.risk || null,
    actor: envelope.actor || '',
    workspaceId: envelope.workspaceId || 'default',
    receiptId: envelope.receiptId || '',
    metadata: envelope.metadata || {},
  }));
}

/** Parse a serialized verdict payload back into a canonical envelope. */
function parseVerdict(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new TypeError('parseVerdict requires a serialized verdict payload');
  }
  if (!CANONICAL_VERDICT_SET.has(payload.verdict)) {
    throw new UnknownVerdictSourceError(payload.sourceLayer || 'unknown', payload.verdict);
  }
  return Object.freeze({
    verdict: payload.verdict,
    sourceLayer: payload.sourceLayer,
    sourceDecision: payload.sourceDecision,
    reason: payload.reason || '',
    risk: payload.risk || null,
    actor: payload.actor || '',
    workspaceId: payload.workspaceId || 'default',
    receiptId: payload.receiptId || '',
    metadata: payload.metadata || {},
  });
}

module.exports = {
  CANONICAL_VERDICTS,
  ADMISSION_TO_CANONICAL,
  MCP_TO_CANONICAL,
  UnknownVerdictSourceError,
  toCanonicalVerdict,
  fromAdmissionDecision,
  fromMcpDecision,
  classifyForUi,
  serializeVerdict,
  parseVerdict,
};
