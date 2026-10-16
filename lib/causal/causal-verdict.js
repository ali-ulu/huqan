'use strict';

// Causal verdict facade. The verdict used to live here in full (555 lines);
// it now carries one concern per module (#2175):
//
//   - causal-verdict-weights.js  status vocabulary + scoring weights
//   - causal-verdict-normalize.js  traversal/edge/branch/signal shaping
//   - causal-verdict-trace.js  trace construction (edges, warnings, flags)
//   - causal-verdict-score.js  status/confidence scoring + shape normalize
//
// This file re-exports the same names from the same path, so kernel.js,
// lib/causal/index.js, lib/provenance-query.js and the test suite keep
// requiring lib/causal/causal-verdict.js unchanged. The code is moved, not
// rewritten: every exported function body is byte identical to the previous
// single-file version.

const {
  CAUSAL_VERDICT_STATUSES,
  CAUSAL_VERDICT_VERSION,
  SUPPORT_RELATION_TYPES,
  CAUSAL_SCORE_WEIGHTS,
} = require('./causal-verdict-weights');

const {
  uniquePush,
  normalizeEdgeLike,
  normalizeBlockedBranch,
  normalizeTraversal,
  normalizeContradictionSignal,
} = require('./causal-verdict-normalize');

const { buildCausalTrace } = require('./causal-verdict-trace');
const { scoreCausalVerdict, normalizeCausalVerdict } = require('./causal-verdict-score');

function resolveVerdictStatus(traversal, trace, contradictionSignal) {
  if (contradictionSignal) return 'contradicts';

  const hasSupport = trace.supportingEdges.length > 0;
  const hasPrevention = trace.preventingEdges.length > 0;

  switch (traversal.stopReason) {
    case 'cycle_detected':
      return 'cycle_blocked';
    case 'depth_exceeded':
    case 'max_edges_exceeded':
      return 'depth_incomplete';
    case 'missing_start':
      return 'inconclusive';
    case 'terminus':
      if (hasSupport) return 'supports';
      if (hasPrevention) return 'contradicts';
      return 'inconclusive';
    default:
      if (hasSupport) return 'supports';
      if (hasPrevention) return 'contradicts';
      return 'inconclusive';
  }
}

function buildCausalVerdict(traversalResult, options = {}) {
  const traversal = normalizeTraversal(traversalResult);
  const trace = buildCausalTrace(traversalResult, options);
  const contradictionSignal = normalizeContradictionSignal(
    options.contradictionSignal
      ?? traversalResult?.meta?.contradictionSignal
      ?? traversalResult?.traversal?.contradictionSignal
      ?? traversalResult?.traversal?.explicitContradiction
      ?? traversalResult?.explicitContradiction,
  );

  const status = resolveVerdictStatus(traversal, trace, contradictionSignal);
  const confidence = scoreCausalVerdict(status, trace, contradictionSignal);
  const reasons = [];
  const reasonSet = new Set();
  const warnings = [...trace.warnings];
  const riskFlags = [...trace.riskFlags];

  uniquePush(reasonSet, reasons, status === 'supports'
    ? 'CAUSAL_PATH_FOUND'
    : status === 'contradicts'
      ? (contradictionSignal ? 'EXPLICIT_CONTRADICTION_SIGNAL' : 'PREVENTS_ONLY_SIGNAL')
      : status === 'cycle_blocked'
        ? 'CYCLE_DETECTED'
        : status === 'depth_incomplete'
          ? 'PARTIAL_TRAVERSAL'
          : 'INCONCLUSIVE_TRAVERSAL');

  if (traversal.stopReason === 'terminus' && trace.supportingEdges.length === 0 && trace.preventingEdges.length === 0) {
    uniquePush(reasonSet, reasons, 'EMPTY_TRAVERSAL');
  }

  if (traversal.stopReason === 'missing_start') {
    uniquePush(reasonSet, reasons, 'MISSING_START');
  }

  if (traversal.stopReason === 'depth_exceeded' || traversal.stopReason === 'max_edges_exceeded') {
    uniquePush(reasonSet, reasons, 'PARTIAL_TRAVERSAL');
  }

  if (traversal.stopReason === 'cycle_detected') {
    uniquePush(reasonSet, reasons, 'CYCLE_DETECTED');
  }

  if (contradictionSignal) {
    uniquePush(reasonSet, reasons, contradictionSignal.reason);
    uniquePush(new Set(warnings), warnings, 'EXPLICIT_CONTRADICTION_SIGNAL');
    uniquePush(new Set(riskFlags), riskFlags, 'explicit_contradiction_signal');
  }

  return normalizeCausalVerdict({
    ok: true,
    verdict: {
      status,
      confidence,
      reasons,
      warnings,
      riskFlags,
      trace,
    },
    meta: {
      source: 'causal-traversal',
      version: CAUSAL_VERDICT_VERSION,
    },
  });
}

module.exports = {
  CAUSAL_VERDICT_STATUSES,
  CAUSAL_VERDICT_VERSION,
  SUPPORT_RELATION_TYPES,
  CAUSAL_SCORE_WEIGHTS,
  buildCausalTrace,
  scoreCausalVerdict,
  normalizeCausalVerdict,
  buildCausalVerdict,
};
