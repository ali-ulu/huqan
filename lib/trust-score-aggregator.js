'use strict';

/**
 * Trust Score aggregator (#1910, "Huqan Certified" Faz 1).
 *
 * Computes a 0-100 score for a workspace from bounded, already-existing
 * evidence — no new tables, no new daemons:
 *
 * - governed proxy actions: `llm-proxy:` mutation-journal entries
 *   (total, upstream error rate, distinct models), windowed to the most
 *   recent WINDOW_ACTIONS_MAX entries;
 * - human-oversight backlog: pending + unresolved tool-approval counts
 *   (injected by the caller, same as the audit command);
 * - review backlog: open candidate-claim count.
 *
 * ## Scoring (documented, deterministic)
 *
 *   score = 100
 *           - 40 * upstreamErrorRate   (proxy actions only, n >= 10)
 *           - min(15, approvalBacklog)
 *           - min(10, floor(claimBacklog / 5))
 *
 * Fewer than MIN_ACTIONS_FOR_SCORE governed actions with no approval or
 * claim activity at all yields `insufficient-data` (score null) instead of
 * a fabricated number. `certified` (the "Huqan Certified" condition) holds
 * when score >= CERTIFIED_MIN_SCORE with at least CERTIFIED_MIN_ACTIONS
 * governed actions in the window.
 *
 * Deliberately NOT scored here: full receipt-chain re-validation over
 * history (use the receipt-bundle export + verify_bundle.py) and
 * per-agent attribution (multi-tenant identity is a follow-up). Both are
 * listed under `limitations` so the number never overclaims.
 */

const SCORE_SCHEMA_VERSION = 'huqan-trust-score-v1';
const WINDOW_ACTIONS_MAX = 10000;
const MIN_ACTIONS_FOR_SCORE = 10;
const CERTIFIED_MIN_SCORE = 85;
const CERTIFIED_MIN_ACTIONS = 100;

function safeList(fn) {
  try {
    const value = fn();
    return Array.isArray(value) ? value : [];
  } catch (_) {
    return [];
  }
}

function upstreamStatusOf(entry) {
  const status = entry && entry.result ? entry.result.upstreamStatus : undefined;
  return Number.isFinite(Number(status)) ? Number(status) : null;
}

function collectProxySignals(graph, windowMax) {
  let entries = [];
  if (graph && typeof graph.getCommittedMutationResultsByPrefix === 'function') {
    entries = safeList(() => graph.getCommittedMutationResultsByPrefix('llm-proxy:'));
  }
  const recent = entries.slice(-Math.max(1, Math.min(WINDOW_ACTIONS_MAX, windowMax || WINDOW_ACTIONS_MAX)));
  const actions = recent.length;
  let errors = 0;
  const models = new Set();
  for (const entry of recent) {
    const status = upstreamStatusOf(entry);
    if (status !== null && status >= 500) errors += 1;
    const model = entry && entry.result && typeof entry.result.model === 'string' ? entry.result.model : '';
    if (model) models.add(model);
  }
  return {
    actions,
    errors,
    errorRate: actions >= MIN_ACTIONS_FOR_SCORE ? errors / actions : 0,
    models: models.size,
    windowCapped: entries.length > recent.length,
  };
}

function collectReviewSignals(graph, workspaceId) {
  let claims = [];
  if (graph && typeof graph.getCandidateClaims === 'function') {
    const result = safeList(() => graph.getCandidateClaims({ workspaceId }));
    claims = result;
  }
  return { openClaims: claims.length };
}

function computeTrustScore({ graph, workspaceId = 'default', approvalCounts = null, windowMax = WINDOW_ACTIONS_MAX } = {}) {
  const proxy = collectProxySignals(graph, windowMax);
  const review = collectReviewSignals(graph, workspaceId);
  const pending = approvalCounts && Number.isFinite(Number(approvalCounts.pending)) ? Number(approvalCounts.pending) : null;
  const unresolved = approvalCounts && Number.isFinite(Number(approvalCounts.unresolved)) ? Number(approvalCounts.unresolved) : null;
  const backlog = pending !== null && unresolved !== null ? pending + unresolved : null;

  const hasActivity = proxy.actions >= MIN_ACTIONS_FOR_SCORE || (backlog !== null && backlog > 0) || review.openClaims > 0;
  if (!hasActivity) {
    return Object.freeze({
      schemaVersion: SCORE_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      workspaceId,
      status: 'insufficient-data',
      score: null,
      certified: false,
      windowActions: proxy.actions,
      signals: Object.freeze({ proxy: Object.freeze(proxy), review: Object.freeze(review), approvals: Object.freeze({ pending, unresolved }) }),
      deductions: Object.freeze({}),
      limitations: Object.freeze([
        'Fewer than 10 governed actions and no approval or review activity: no score is emitted instead of a fabricated one.',
      ]),
    });
  }

  const errorDeduction = 40 * proxy.errorRate;
  const backlogDeduction = backlog !== null ? Math.min(15, backlog) : 0;
  const claimsDeduction = Math.min(10, Math.floor(review.openClaims / 5));
  const deductions = Object.freeze({
    upstreamErrors: Number(errorDeduction.toFixed(2)),
    approvalBacklog: backlogDeduction,
    reviewBacklog: claimsDeduction,
  });
  const score = Math.max(0, Math.min(100, Math.round(100 - errorDeduction - backlogDeduction - claimsDeduction)));
  const certified = score >= CERTIFIED_MIN_SCORE && proxy.actions >= CERTIFIED_MIN_ACTIONS;

  return Object.freeze({
    schemaVersion: SCORE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    workspaceId,
    status: 'scored',
    score,
    certified,
    windowActions: proxy.actions,
    signals: Object.freeze({ proxy: Object.freeze(proxy), review: Object.freeze(review), approvals: Object.freeze({ pending, unresolved }) }),
    deductions,
    limitations: Object.freeze([
      'Full receipt-chain re-validation is out of scope; use the receipt-bundle export plus verify_bundle.py.',
      'Score is workspace-scoped; per-agent attribution is a follow-up.',
    ]),
  });
}

module.exports = {
  SCORE_SCHEMA_VERSION,
  WINDOW_ACTIONS_MAX,
  MIN_ACTIONS_FOR_SCORE,
  CERTIFIED_MIN_SCORE,
  CERTIFIED_MIN_ACTIONS,
  computeTrustScore,
};
