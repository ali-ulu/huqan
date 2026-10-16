const { buildBackgroundProvenance } = require('./background-provenance');
const { AUDIT_EVENTS } = require('./audit-log');
const { buildCanonicalReceiptPayload } = require('./receipt/canonical-receipt');
const { toCanonicalVerdict } = require('./verdict/action-verdict');
const { normalizeWorkspaceId } = require('./workspace-id');
const {
  CONFLICT_TYPES,
  CONFLICT_RECOMMENDATIONS,
  CAUSAL_RELATIONS,
  nowIso,
  coerceString,
  normalizeCandidateClaim,
  buildCandidateClaim,
} = require('./conflict-claim');
const {
  getGraph,
  getJournalingKernel,
  appendAudit,
  detectClaimConflict,
} = require('./conflict-detect');
function admissionReceiptDetails(admission) {
  if (!admission || typeof admission !== 'object') return {};
  return { ...(admission.receiptId ? { receiptId: admission.receiptId } : {}), ...(admission.receipt && typeof admission.receipt === 'object' ? { receipt: JSON.parse(JSON.stringify(admission.receipt)) } : {}) };
}

/**
 * #217: admission-gated, durably-journaled acceptance for a candidate claim
 * whose conflict recommendation is ACCEPT. Mirrors the same
 * _evaluateLearnAdmission gate kernel.js's _commitBackgroundEdge/proposeEdge
 * use for other background writes (approvalRequired: false, so risk-based
 * auto-review can still hold a candidate rather than always writing it
 * unconditionally), then wraps the node/edge writes in
 * Graph.runMutationOnce() the same way kernel.js learn() does, reusing the
 * exact same canonical-receipt building -- no new receipt logic here.
 */
function acceptCandidateClaimJournaled(kernel, candidate, conflict, built, evaluateLearnAdmission) {
  const workspaceId = candidate.workspaceId;
  const provenance = candidate.provenance && typeof candidate.provenance === 'object'
    ? candidate.provenance
    : buildBackgroundProvenance('candidate_claim', workspaceId, {}, { contractVersion: kernel.contractVersion, trustPolicyPath: kernel.trustPolicyPath });
  const proposalText = candidate.proposedEdge
    ? `${candidate.proposedEdge.from} ${candidate.proposedEdge.relation} ${candidate.proposedEdge.to}`
    : candidate.claim;

  const admissionOpts = {
    workspaceId,
    provenanceId: provenance.provenanceId,
    actor: provenance.actor,
    agentId: provenance.actor,
    sourceType: provenance.sourceType,
    sourceRef: provenance.sourceRef,
    approvalRequired: false,
    admissionReason: 'candidate_claim_accepted',
    admissionContext: { backgroundSource: 'candidate_claim', candidateId: candidate.candidateId },
  };
  const admission = evaluateLearnAdmission(proposalText, admissionOpts, provenance, workspaceId);

  if (!admission || admission.outcome !== 'allow') {
    // Not written canonically: the "accept" recommendation from conflict
    // detection is necessary but not sufficient -- admission (risk-based)
    // gets the final say, same as it does for learn() and other background
    // writes. Recorded as pending so it stays visible/reviewable rather
    // than silently disappearing.
    candidate.status = 'pending';
    // The accept path stamped reviewedAt/reviewedBy before admission was
    // consulted; a held row must not carry a review stamp nothing granted.
    candidate.reviewedAt = '';
    candidate.reviewedBy = '';
    if (kernel.graph && typeof kernel.graph.addCandidateClaim === 'function') {
      kernel.graph.addCandidateClaim(candidate);
    }
    appendAudit(kernel, {
      eventType: admission && admission.outcome === 'reject' ? 'REJECT' : 'REVIEW',
      targetType: 'candidate_claim',
      targetId: candidate.candidateId,
      details: {
        candidateId: candidate.candidateId,
        conflict: conflict.conflict,
        type: conflict.type,
        recommendation: conflict.recommendation,
        reason: admission ? admission.reason : 'admission_unavailable',
        admissionOutcome: admission ? admission.outcome : 'review',
        ...(admission ? admissionReceiptDetails(admission) : {}),
      },
    }, provenance, workspaceId);
    return { candidate, conflict, warnings: built.warnings, admission };
  }

  const operationId = `auto-mut-candidate-${candidate.candidateId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const outcome = kernel.graph.runMutationOnce(operationId, () => {
    kernel.graph.addCandidateClaim(candidate);
    let edge = null;
    if (candidate.proposedEdge) {
      const proposedEdge = candidate.proposedEdge;
      kernel.graph.addNode(proposedEdge.from, proposedEdge.from, provenance, { workspaceId });
      kernel.graph.addNode(proposedEdge.to, proposedEdge.to, provenance, { workspaceId });
      edge = kernel.graph.addEdge(proposedEdge.from, proposedEdge.to, proposedEdge.relation, {
        workspaceId,
        provenance,
        strength: proposedEdge.strength,
        ...(CAUSAL_RELATIONS.has(proposedEdge.relation) && proposedEdge.strength === undefined
          ? { strength: proposedEdge.confidence ?? 0.5 }
          : {}),
        confidence: proposedEdge.confidence,
        source: proposedEdge.source || 'candidate',
        sourceRef: proposedEdge.sourceRef || proposedEdge.source_ref || '',
        evidence: Array.isArray(proposedEdge.evidence)
          ? proposedEdge.evidence
          : (proposedEdge.evidence ? [proposedEdge.evidence] : [candidate.claim].filter(Boolean)),
      });
    }
    appendAudit(kernel, {
      eventType: AUDIT_EVENTS.CLAIM_ACCEPTED,
      targetType: 'candidate_claim',
      targetId: candidate.candidateId,
      details: {
        candidateId: candidate.candidateId,
        conflict: conflict.conflict,
        type: conflict.type,
        recommendation: conflict.recommendation,
      },
    }, provenance, workspaceId);
    return { candidate, edge };
  }, {
    buildCanonicalReceipt: () => {
      const receipt = admission.receipt;
      if (!receipt || typeof receipt !== 'object') return null;
      return buildCanonicalReceiptPayload({
        ...receipt,
        metadata: {
          ...(receipt.metadata || {}),
          mutationOperationId: operationId,
          committedAt: nowIso(),
        },
      }, { verdict: toCanonicalVerdict('admission', receipt.decision) });
    },
  });

  if (!outcome.replayed && !outcome.persisted) {
    try { kernel.graph.save(); } catch (error) { console.error('[conflict-detector] Graph save error:', error.message); }
  }

  return {
    candidate,
    conflict,
    warnings: built.warnings,
    admission,
    mutation: { operationId, replayed: outcome.replayed === true, receiptId: outcome.receipt?.receiptId || null },
  };
}

function routeCandidateClaim(kernelOrGraph, claim, opts = {}, deps = {}) {
  const graph = getGraph(kernelOrGraph);
  const built = buildCandidateClaim(claim, opts);
  const candidate = built.candidate;
  const conflict = detectClaimConflict(kernelOrGraph, candidate, opts);

  candidate.conflict = conflict;
  candidate.recommendation = conflict.recommendation;
  candidate.workspaceId = normalizeWorkspaceId(candidate.workspaceId || opts.workspaceId || conflict.workspaceId);
  candidate.proposedEdge = candidate.proposedEdge
    ? {
        ...candidate.proposedEdge,
        workspaceId: normalizeWorkspaceId(candidate.proposedEdge.workspaceId || candidate.workspaceId),
      }
    : null;

  const actor = coerceString(opts.actor || candidate.provenance?.actor, 'system');
  const reviewedAt = nowIso();

  if (conflict.recommendation === CONFLICT_RECOMMENDATIONS.ACCEPT) {
    candidate.status = 'accepted';
    candidate.reviewedAt = reviewedAt;
    candidate.reviewedBy = coerceString(opts.reviewedBy || actor, 'system');

    // #217: when a real Kernel is available, route acceptance through the
    // same admission gate + durable mutation journal every other canonical
    // write path uses, instead of writing addNode()/addEdge() directly.
    const kernel = getJournalingKernel(kernelOrGraph, deps.evaluateLearnAdmission);
    if (kernel) {
      return acceptCandidateClaimJournaled(kernel, candidate, conflict, built, deps.evaluateLearnAdmission);
    }

    // Fallback for callers that pass a bare Graph (no Kernel available to
    // evaluate admission against, e.g. some existing tests/utilities):
    // preserves the prior direct-write behavior unchanged.
    if (graph && typeof graph.addCandidateClaim === 'function') {
      graph.addCandidateClaim(candidate);
    }
    if (candidate.proposedEdge && graph && typeof graph.addNode === 'function' && typeof graph.addEdge === 'function') {
      const edge = candidate.proposedEdge;
      const provenance = candidate.provenance || null;
      graph.addNode(edge.from, edge.from, provenance, { workspaceId: candidate.workspaceId });
      graph.addNode(edge.to, edge.to, provenance, { workspaceId: candidate.workspaceId });
      graph.addEdge(edge.from, edge.to, edge.relation, {
        workspaceId: candidate.workspaceId,
        provenance,
        strength: edge.strength,
        ...(CAUSAL_RELATIONS.has(edge.relation) && edge.strength === undefined
          ? { strength: edge.confidence ?? 0.5 }
          : {}),
        confidence: edge.confidence,
        source: edge.source || 'candidate',
        sourceRef: edge.sourceRef || edge.source_ref || '',
        evidence: Array.isArray(edge.evidence) ? edge.evidence : (edge.evidence ? [edge.evidence] : [candidate.claim].filter(Boolean)),
      });
    }
    appendAudit(kernelOrGraph, {
      eventType: AUDIT_EVENTS.CLAIM_ACCEPTED,
      targetType: 'candidate_claim',
      targetId: candidate.candidateId,
      details: {
        candidateId: candidate.candidateId,
        conflict: conflict.conflict,
        type: conflict.type,
        recommendation: conflict.recommendation,
      },
    }, candidate.provenance, candidate.workspaceId);
    return { candidate, conflict, warnings: built.warnings };
  }

  if (conflict.recommendation === CONFLICT_RECOMMENDATIONS.REJECT) {
    candidate.status = 'rejected';
    candidate.reviewedAt = reviewedAt;
    candidate.reviewedBy = coerceString(opts.reviewedBy || actor, 'system');
    if (graph && typeof graph.addCandidateClaim === 'function') {
      graph.addCandidateClaim(candidate);
    }
    appendAudit(kernelOrGraph, {
      eventType: AUDIT_EVENTS.CLAIM_REJECTED,
      targetType: 'candidate_claim',
      targetId: candidate.candidateId,
      details: {
        candidateId: candidate.candidateId,
        conflict: conflict.conflict,
        type: conflict.type,
        recommendation: conflict.recommendation,
      },
    }, candidate.provenance, candidate.workspaceId);
    return { candidate, conflict, warnings: built.warnings };
  }

  candidate.status = 'pending';
  if (graph && typeof graph.addCandidateClaim === 'function') {
    graph.addCandidateClaim(candidate);
  }
  if (conflict.conflict) {
    appendAudit(kernelOrGraph, {
      eventType: AUDIT_EVENTS.CONFLICT_DETECTED,
      targetType: 'candidate_claim',
      targetId: candidate.candidateId,
      details: {
        candidateId: candidate.candidateId,
        conflict: conflict.conflict,
        type: conflict.type,
        recommendation: conflict.recommendation,
        reason: conflict.reason,
        confidenceDelta: conflict.confidenceDelta,
      },
    }, candidate.provenance, candidate.workspaceId);
  }
  appendAudit(kernelOrGraph, {
    eventType: AUDIT_EVENTS.CLAIM_FLAGGED,
    targetType: 'candidate_claim',
    targetId: candidate.candidateId,
    details: {
      candidateId: candidate.candidateId,
      conflict: conflict.conflict,
      type: conflict.type,
      recommendation: conflict.recommendation,
      reason: conflict.reason,
    },
  }, candidate.provenance, candidate.workspaceId);
  return { candidate, conflict, warnings: built.warnings };
}

module.exports = {
  CONFLICT_RECOMMENDATIONS,
  CONFLICT_TYPES,
  buildCandidateClaim,
  detectClaimConflict,
  normalizeCandidateClaim,
  routeCandidateClaim,
};
