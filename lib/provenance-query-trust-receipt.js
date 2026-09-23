'use strict';

// Trust-receipt assembly for the provenance query surface: the trust-graph
// query, receipt building and the causal bridge block. Split out of
// lib/provenance-query.js (#2162): moved here byte-identical. Record
// collection, the bounded audit page and shape normalization live in their
// own modules.

const { matchesCanonicalTarget } = require('./canonical-target-match');
const { normalizeCausalVerdict } = require('./causal/causal-verdict');
const { deriveTrustStatus } = require('./trust-status');
const {
  coerceString,
  getGraph,
  normalizeTrustReceipt,
  nowIso,
  safeJsonClone,
} = require('./provenance-query-shapes');
const { findCanonicalRecord, queryProvenance } = require('./provenance-query-records');
const { queryAuditTrailPage, queryCandidateClaims } = require('./provenance-query-audit-page');
const { normalizeWorkspaceId } = require('./workspace-id');

function queryAuditTrail(target, filters = {}) {
  return queryAuditTrailPage(target, filters).items;
}

function queryTrustGraph(target, filters = {}) {
  const graph = getGraph(target);
  const workspaceId = normalizeWorkspaceId(filters.workspaceId);
  const provenance = queryProvenance(graph, filters).filter((item) => item.kind !== 'candidate_claim');
  const auditTrail = queryAuditTrail(graph, filters);
  const candidateClaims = queryCandidateClaims(graph, filters);
  const canonical = findCanonicalRecord(graph, filters, provenance, candidateClaims);
  const conflict = candidateClaims.find((candidate) => candidate.conflict) || null;
  const status = deriveTrustStatus(canonical, candidateClaims, provenance);
  const entityResolution = provenance.find((item) => item && item.entityResolution)?.entityResolution || null;
  const shadowingCandidate = canonical
    ? candidateClaims.find((candidate) => matchesCanonicalTarget(candidate, canonical)) || null
    : null;
  const selectedCandidate = shadowingCandidate || candidateClaims[0] || null;
  const canonicalReceipt = Boolean(canonical && status === 'canonical');

  const receipt = normalizeTrustReceipt({
    receiptId: filters.receiptId,
    targetType: canonicalReceipt ? canonical?.targetType : (selectedCandidate ? 'candidate_claim' : filters.targetType || ''),
    targetId: canonicalReceipt
      ? canonical?.targetId
      : selectedCandidate?.candidateId || filters.targetId || filters.candidateId || filters.sourceRef || filters.provenanceId || '',
    claim: canonicalReceipt ? canonical?.claim : selectedCandidate?.claim || filters.claim || '',
    status,
    workspaceId,
    provenance: (canonicalReceipt ? canonical?.provenance : null) || selectedCandidate?.provenance || provenance[0]?.provenance || null,
    trustPolicyVersion: (canonicalReceipt ? canonical?.trustPolicyVersion : selectedCandidate?.provenance?.trustPolicyVersion) || provenance[0]?.trustPolicyVersion || '',
    // `unknown` is precisely the state `deriveTrustStatus` reaches when there is
    // no canonical record, no candidate claim and no provenance record -- there
    // is nothing here to be confident about. The `?? 0.5` fallbacks below are
    // for a record that exists but did not record a confidence; reaching them
    // with no record at all published a number nobody measured, inside an
    // artifact whose whole purpose is to say what the evidence supports.
    //
    // 0.5 was also the worst available choice of invented number: it passes
    // `confidence >= 0.5`, the threshold this repo already uses to separate
    // "verified" from "too weak to treat as truth"
    // (lib/risk-rules.js, detectWeakPartialMatch) -- which defaults an absent
    // confidence to 0 for the same reason. A receipt for a target that does not
    // exist cleared that bar.
    //
    // The published receipt schema requires `confidence` to be a number in
    // [0, 1] (specs/axiom-trust-protocol/0.1, frozen), so absence cannot be
    // expressed by omitting it or sending null. 0 is the honest floor, and
    // keying it off `status` means the two fields cannot drift apart.
    confidence: status === 'unknown'
      ? 0
      : canonicalReceipt
        ? canonical?.confidence ?? provenance[0]?.confidence ?? 0.5
        : selectedCandidate?.provenance?.confidence ?? provenance[0]?.confidence ?? 0.5,
    auditTrail,
    conflict: conflict?.conflict || null,
    candidateClaim: selectedCandidate || null,
    canonical: canonicalReceipt,
    ...(entityResolution ? { entityResolution } : {}),
    generatedAt: nowIso(),
  });

  return {
    receipt,
    status,
    canonical,
    provenance,
    auditTrail,
    candidateClaims,
    conflict: conflict?.conflict || null,
    workspaceId,
  };
}

function normalizeCausalBridgeStatus(status) {
  switch (status) {
    case 'supports':
      return 'pass';
    case 'contradicts':
      return 'fail';
    case 'cycle_blocked':
      return 'blocked';
    case 'depth_incomplete':
      return 'incomplete';
    case 'inconclusive':
    default:
      return 'not_applicable';
  }
}

function normalizeCausalReceiptBlock(causalVerdict) {
  if (causalVerdict == null) return null;

  const verdict = normalizeCausalVerdict(causalVerdict);
  if (!verdict) return null;

  return {
    status: verdict.verdict.status,
    confidence: verdict.verdict.confidence,
    bridge: normalizeCausalBridgeStatus(verdict.verdict.status),
    warnings: [...verdict.verdict.warnings],
    riskFlags: [...verdict.verdict.riskFlags],
    trace: safeJsonClone(verdict.verdict.trace, {}),
    source: 'causal-verdict',
    version: '1.0.0',
  };
}

function buildTrustReceipt(input = {}, opts = {}) {
  const target = getGraph(opts.target || opts.graph || opts.kernel || input.target || input.graph || input.kernel);
  const filters = {
    ...input,
    ...opts,
  };
  const causalVerdict = filters.causalVerdict ?? input.causalVerdict ?? opts.causalVerdict ?? null;
  delete filters.target;
  delete filters.graph;
  delete filters.kernel;
  delete filters.crossWorkspace;
  delete filters.causalVerdict;
  const result = queryTrustGraph(target, filters);
  if (!causalVerdict) {
    return result.receipt;
  }

  return {
    ...result.receipt,
    causal: normalizeCausalReceiptBlock(causalVerdict),
  };
}

module.exports = {
  buildTrustReceipt,
  normalizeCausalBridgeStatus,
  normalizeCausalReceiptBlock,
  queryAuditTrail,
  queryTrustGraph,
};
