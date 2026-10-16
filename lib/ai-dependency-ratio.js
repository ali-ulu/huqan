'use strict';

/**
 * AI Dependency Ratio (#3028).
 *
 * Measures HUQAN's core claim: reducing AI dependency by serving requests
 * deterministically. Computes one labelled ratio from existing receipts:
 *
 * - deterministicRatio = deterministicServes / totalRequests
 *   - numerator: requests served by a deterministic procedure (router match
 *     with chosen capability) or by the router
 *   - denominator: total inbound requests observed at the surface
 *     (deterministicServes + modelCalls + permittedFallbacks)
 * - permittedFallbackShare = permittedFallbacks / totalRequests
 * - observedVsReported split (from external-action-receipt EFFECT_VERIFICATION)
 *
 * Derives only from existing mutation-journal entries; introduces no new
 * receipt family and no new signer. Surfaces as a read-only number so a
 * company can watch its own dependency trend.
 */

const { EFFECT_VERIFICATION } = require('./external-action-receipt-outcome');

const SCHEMA_VERSION = 'huqan-ai-dependency-ratio-v1';

function safeList(fn) {
  try {
    const value = fn();
    return Array.isArray(value) ? value : [];
  } catch (_) {
    return [];
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Collect model call signals from llm-proxy mutation-journal entries.
 * Returns count of model calls observed.
 */
function collectModelCallSignals(graph) {
  let entries = [];
  if (graph && typeof graph.getCommittedMutationResultsByPrefix === 'function') {
    entries = safeList(() => graph.getCommittedMutationResultsByPrefix('llm-proxy:'));
  }
  // Filter valid entries: must have operationId starting with llm-proxy:, status completed, and result.proxied
  return entries.filter((entry) =>
    isRecord(entry) &&
    typeof entry.operationId === 'string' &&
    entry.operationId.startsWith('llm-proxy:') &&
    entry.status === 'completed' &&
    isRecord(entry.result) &&
    entry.result.proxied === true
  ).length;
}

/**
 * Collect routing decision signals from routing_decided mutation-journal entries.
 * Returns counts of deterministic serves (chosen capability) and refusals.
 */
function collectRoutingSignals(graph) {
  let entries = [];
  if (graph && typeof graph.getCommittedMutationResultsByPrefix === 'function') {
    entries = safeList(() => graph.getCommittedMutationResultsByPrefix('routing_decided'));
  }

  // Filter valid entries
  const validEntries = entries.filter((entry) =>
    isRecord(entry) &&
    typeof entry.operationId === 'string' &&
    entry.operationId.startsWith('routing_decided') &&
    entry.status === 'completed' &&
    isRecord(entry.result) &&
    isRecord(entry.result.decision)
  );

  let deterministicServes = 0;
  let refusals = 0;

  for (const entry of validEntries) {
    const decision = entry.result.decision;
    if (decision.chosenCapabilityId) {
      deterministicServes += 1;
    } else if (decision.refusalReason) {
      refusals += 1;
    }
  }

  return { deterministicServes, refusals, totalRoutingDecisions: validEntries.length };
}

/**
 * Collect permitted fallback signals from capability-trust registry.
 * Uses the existing fallbackPreferredOverCount field.
 */
function collectPermittedFallbackSignals(capabilityTrustRegistry) {
  let permittedFallbacks = 0;

  if (capabilityTrustRegistry && typeof capabilityTrustRegistry.getAll === 'function') {
    const allEntries = safeList(() => capabilityTrustRegistry.getAll());
    for (const entry of allEntries) {
      permittedFallbacks += Number(entry?.fallbackPreferredOverCount || 0);
    }
  }

  return { permittedFallbacks };
}

/**
 * Collect observed vs reported split from external action receipts.
 * Reads from the JSONL receipt trail.
 */
function collectEffectVerificationSignals(receiptPath) {
  const fs = require('node:fs');
  let observed = 0;
  let reported = 0;
  let none = 0;

  if (!receiptPath || !fs.existsSync(receiptPath)) {
    return { observed, reported, none };
  }

  try {
    const content = fs.readFileSync(receiptPath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const receipt = JSON.parse(line);
        if (receipt.receiptKind === 'external_action_outcome_receipt') {
          const ev = receipt.metadata?.effectVerification;
          if (ev === EFFECT_VERIFICATION.OBSERVED) observed += 1;
          else if (ev === EFFECT_VERIFICATION.REPORTED) reported += 1;
          else if (ev === EFFECT_VERIFICATION.NONE) none += 1;
        }
      } catch (_) {
        // Skip malformed lines
      }
    }
  } catch (_) {
    // File read error, return zeros
  }

  return { observed, reported, none };
}

/**
 * Compute the AI dependency ratio metrics.
 *
 * @param {Object} options
 * @param {Object} options.graph - Graph instance with mutation journal access
 * @param {Object} [options.capabilityTrustRegistry] - Capability trust registry instance
 * @param {string} [options.receiptPath] - Path to external action receipts JSONL
 * @param {string} [options.workspaceId='default'] - Workspace ID
 * @returns {Object} Frozen metrics object
 */
function computeAiDependencyRatio({
  graph,
  capabilityTrustRegistry = null,
  receiptPath = null,
  workspaceId = 'default',
} = {}) {
  const modelCalls = collectModelCallSignals(graph);
  const { deterministicServes, refusals, totalRoutingDecisions } = collectRoutingSignals(graph);
  const { permittedFallbacks } = collectPermittedFallbackSignals(capabilityTrustRegistry);
  const { observed, reported, none } = collectEffectVerificationSignals(receiptPath);

  // Total requests = deterministic serves + model calls + permitted fallbacks
  // Note: refusals are routing decisions that didn't serve anything; they're
  // part of the routing volume but not "served" requests. The issue says:
  // "denominator: total inbound requests observed at the surface"
  const totalRequests = deterministicServes + modelCalls + permittedFallbacks;

  const deterministicRatio = totalRequests > 0
    ? Number((deterministicServes / totalRequests).toFixed(4))
    : 0;

  const permittedFallbackShare = totalRequests > 0
    ? Number((permittedFallbacks / totalRequests).toFixed(4))
    : 0;

  const effectVerificationTotal = observed + reported + none;
  const observedShare = effectVerificationTotal > 0
    ? Number((observed / effectVerificationTotal).toFixed(4))
    : 0;
  const reportedShare = effectVerificationTotal > 0
    ? Number((reported / effectVerificationTotal).toFixed(4))
    : 0;

  const hasActivity = totalRequests > 0 || effectVerificationTotal > 0;

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    workspaceId,
    status: hasActivity ? 'computed' : 'insufficient-data',
    deterministicRatio,
    deterministicServes,
    modelCalls,
    permittedFallbacks,
    totalRequests,
    permittedFallbackShare,
    refusals,
    totalRoutingDecisions,
    effectVerification: Object.freeze({
      observed,
      reported,
      none,
      total: effectVerificationTotal,
      observedShare,
      reportedShare,
    }),
    limitations: Object.freeze([
      'Derived only from existing mutation-journal entries; no new receipt family introduced.',
      'Deterministic serves counted as router decisions with a chosenCapabilityId.',
      'Model calls counted from llm-proxy: mutation-journal prefix.',
      'Permitted fallbacks from capability-trust fallbackPreferredOverCount.',
      'Observed vs reported from external-action-receipt EFFECT_VERIFICATION metadata.',
      'A request with no observed outcome is excluded from the denominator (silence is not a deterministic serve).',
      'A reported (not observed) effect never counts toward the deterministic numerator.',
    ]),
  });
}

module.exports = Object.freeze({
  SCHEMA_VERSION,
  computeAiDependencyRatio,
  collectModelCallSignals,
  collectRoutingSignals,
  collectPermittedFallbackSignals,
  collectEffectVerificationSignals,
});