const { randomUUID } = require('crypto');
const { buildProvenance } = require('./provenance-ingest');
const { AUDIT_EVENTS } = require('./audit-log');
const { buildCanonicalReceiptPayload } = require('./receipt/canonical-receipt');
const { toCanonicalVerdict } = require('./verdict/action-verdict');
const { normalizeWorkspaceId } = require('./workspace-id');

const CONFLICT_TYPES = Object.freeze({
  AGENT_VS_AGENT: 'agent-vs-agent',
  AGENT_VS_GRAPH: 'agent-vs-graph',
  AGENT_VS_CAUSAL: 'agent-vs-causal',
  PROVENANCE_MISMATCH: 'provenance-mismatch',
  WORKSPACE_SCOPE_MISMATCH: 'workspace-scope-mismatch',
});

const CONFLICT_RECOMMENDATIONS = Object.freeze({
  ACCEPT: 'accept',
  FLAG: 'flag',
  REJECT: 'reject',
});

const RELATION_CONFLICTS = Object.freeze({
  CAUSES: ['PREVENTS'],
  PREVENTS: ['CAUSES'],
  SUPPORTS: ['OPPOSES'],
  OPPOSES: ['SUPPORTS'],
});

const CAUSAL_RELATIONS = new Set(['CAUSES', 'PREVENTS', 'ENABLES', 'DEPENDS_ON', 'LEADS_TO']);

function nowIso() {
  return new Date().toISOString();
}

const { isPlainObject } = require('./is-plain-object');

function safeJsonParse(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  if (isPlainObject(value) || Array.isArray(value)) return value;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function coerceString(value, fallback = '') {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value === 0) return '0';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}

function relationConflicts(a, b) {
  const conflicts = RELATION_CONFLICTS[a];
  return Array.isArray(conflicts) && conflicts.includes(b);
}

function edgeRef(edge = {}) {
  return {
    from: edge.from || edge.fromId || '',
    to: edge.to || edge.toId || '',
    relation: edge.relation || '',
    confidence: typeof edge.confidence === 'number'
      ? edge.confidence
      : typeof edge.weight === 'number'
        ? edge.weight
        : 0.5,
    workspaceId: normalizeWorkspaceId(edge.workspaceId || edge.workspace_id),
    provenanceId: coerceString(edge.provenance?.provenanceId || edge.provenanceId, ''),
    sourceRef: coerceString(edge.provenance?.sourceRef || edge.sourceRef || edge.source_ref, ''),
  };
}

function normalizeCandidateClaim(candidate = {}) {
  const provenance = safeJsonParse(candidate.provenance, null);
  const proposedEdge = safeJsonParse(candidate.proposedEdge, null);
  const conflict = safeJsonParse(candidate.conflict, null);
  const workspaceId = normalizeWorkspaceId(
    candidate.workspaceId
      || provenance?.workspaceId
      || proposedEdge?.workspaceId
      || conflict?.workspaceId
  );

  return {
    candidateId: coerceString(candidate.candidateId, `cand_${randomUUID()}`),
    claim: coerceString(candidate.claim, ''),
    proposedEdge: proposedEdge && typeof proposedEdge === 'object'
      ? {
          ...proposedEdge,
          workspaceId: normalizeWorkspaceId(proposedEdge.workspaceId || workspaceId),
          ...(CAUSAL_RELATIONS.has(coerceString(proposedEdge.relation))
            ? {
                strength: typeof proposedEdge.strength === 'number'
                  ? proposedEdge.strength
                  : typeof proposedEdge.confidence === 'number'
                    ? proposedEdge.confidence
                    : 0.5,
              }
            : {}),
        }
      : null,
    provenance: provenance && typeof provenance === 'object'
      ? {
          ...provenance,
          workspaceId: normalizeWorkspaceId(provenance.workspaceId || workspaceId),
        }
      : null,
    conflict: conflict && typeof conflict === 'object' ? conflict : null,
    recommendation: coerceString(candidate.recommendation, CONFLICT_RECOMMENDATIONS.ACCEPT),
    status: coerceString(candidate.status, 'pending'),
    workspaceId,
    createdAt: coerceString(candidate.createdAt, nowIso()),
    reviewedAt: coerceString(candidate.reviewedAt, ''),
    reviewedBy: coerceString(candidate.reviewedBy, ''),
    warnings: Array.isArray(candidate.warnings) ? [...candidate.warnings] : [],
  };
}

function buildCandidateClaim(input = {}, opts = {}) {
  const strictProvenance = opts.strictProvenance === true;
  const workspaceId = normalizeWorkspaceId(
    input.workspaceId
      || opts.workspaceId
      || input.provenance?.workspaceId
      || opts.provenance?.workspaceId
  );
  const claimText = coerceString(
    input.claim
      || input.text
      || input.statement
      || opts.claim
      || opts.text
      || opts.statement,
    ''
  );

  const provenanceInput = isPlainObject(input.provenance)
    ? input.provenance
    : (isPlainObject(opts.provenance) ? opts.provenance : {});

  const provenanceResult = buildProvenance(provenanceInput, {
    ...opts,
    strictProvenance,
    workspaceId,
    sourceRef: input.sourceRef || opts.sourceRef || provenanceInput.sourceRef,
    sourceTitle: input.sourceTitle || opts.sourceTitle || provenanceInput.sourceTitle,
    sourceType: input.sourceType || opts.sourceType || provenanceInput.sourceType,
    sourceSubType: input.sourceSubType || opts.sourceSubType || provenanceInput.sourceSubType,
    actor: input.actor || opts.actor || provenanceInput.actor,
    timestamp: input.timestamp || opts.timestamp || provenanceInput.timestamp,
    confidence: input.confidence ?? opts.confidence ?? provenanceInput.confidence,
  });

  const candidate = normalizeCandidateClaim({
    candidateId: input.candidateId || opts.candidateId || `cand_${randomUUID()}`,
    claim: claimText,
    proposedEdge: input.proposedEdge || opts.proposedEdge || (input.subject || input.relation || input.object
      ? {
          from: input.subject || input.from || '',
          relation: input.relation || '',
          to: input.object || input.to || '',
          polarity: input.polarity || '',
          confidence: input.confidence ?? opts.confidence ?? provenanceResult.provenance.confidence ?? 0.5,
          provenanceId: provenanceResult.provenance.provenanceId,
          workspaceId,
        }
      : null),
    provenance: provenanceResult.provenance,
    conflict: null,
    recommendation: CONFLICT_RECOMMENDATIONS.ACCEPT,
    status: 'pending',
    workspaceId,
    createdAt: input.createdAt || opts.createdAt || nowIso(),
    reviewedAt: input.reviewedAt || opts.reviewedAt || '',
    reviewedBy: input.reviewedBy || opts.reviewedBy || '',
    warnings: provenanceResult.warnings,
  });

  return {
    candidate,
    provenance: provenanceResult.provenance,
    warnings: provenanceResult.warnings,
    trustPolicy: provenanceResult.policy,
  };
}

function summarizeExistingEvidence(edges = []) {
  return edges.map(edgeRef);
}

function summarizeProposedEvidence(candidate) {
  if (!candidate || !candidate.proposedEdge) return [];
  return [edgeRef(candidate.proposedEdge)];
}

function getGraph(kernelOrGraph) {
  return kernelOrGraph && kernelOrGraph.graph ? kernelOrGraph.graph : kernelOrGraph;
}

// #217: candidate-claim acceptance can only be admission-gated and
// durably journaled when a real Kernel (not a bare Graph) is available --
// _evaluateLearnAdmission and runMutationOnce are Kernel/Graph methods that
// a bare Graph passed directly by an older caller/test does not have both
// of. Falls back to null (old direct-write behavior) rather than throwing,
// so existing graph-only callers are unaffected.
function getJournalingKernel(kernelOrGraph) {
  for (const candidate of [kernelOrGraph, kernelOrGraph && kernelOrGraph.kernel]) {
    const hasAdmission = candidate && typeof candidate._evaluateLearnAdmission === 'function';
    const hasJournal = candidate && candidate.graph && typeof candidate.graph.runMutationOnce === 'function';
    if (hasAdmission && hasJournal) return candidate;
  }
  return null;
}

function appendAudit(kernelOrGraph, event, provenance, workspaceId) {
  const payload = { ...event, workspaceId };
  if (kernelOrGraph && typeof kernelOrGraph._appendAuditEvent === 'function') {
    return kernelOrGraph._appendAuditEvent(payload, provenance, workspaceId);
  }
  if (kernelOrGraph && typeof kernelOrGraph.appendAuditEvent === 'function') {
    return kernelOrGraph.appendAuditEvent(payload, provenance ? { provenance, workspaceId } : { workspaceId });
  }
  return null;
}

function buildConflictResult({
  conflict = false,
  type = null,
  recommendation = CONFLICT_RECOMMENDATIONS.ACCEPT,
  reason = 'No conflicting graph-backed claim found.',
  confidenceDelta = 0,
  existingEvidence = [],
  proposedEvidence = [],
  workspaceId = 'default',
  provenanceId = '',
  sourceRef = '',
} = {}) {
  return {
    conflict,
    type,
    recommendation,
    reason,
    confidenceDelta,
    existingEvidence,
    proposedEvidence,
    workspaceId,
    provenanceId,
    sourceRef,
  };
}

function detectClaimConflict(kernelOrGraph, claim, opts = {}) {
  const graph = getGraph(kernelOrGraph);
  const workspaceId = normalizeWorkspaceId(claim?.workspaceId || opts.workspaceId);
  const normalizedProposed = normalizeCandidateClaim({ proposedEdge: claim?.proposedEdge || claim?.edge || claim }).proposedEdge;
  const proposedEdge = normalizedProposed && coerceString(normalizedProposed.from) && coerceString(normalizedProposed.to) && coerceString(normalizedProposed.relation)
    ? normalizedProposed
    : (isPlainObject(claim) && claim.subject && claim.relation && claim.object
      ? {
          from: claim.subject,
          relation: claim.relation,
          to: claim.object,
          confidence: claim.confidence ?? 0.5,
          provenanceId: claim.provenance?.provenanceId || claim.provenanceId || '',
          sourceRef: claim.provenance?.sourceRef || claim.sourceRef || '',
          workspaceId,
        }
      : null);
  const provenance = isPlainObject(claim?.provenance) ? claim.provenance : null;
  const provenanceId = coerceString(provenance?.provenanceId || claim?.provenanceId, '');
  const sourceRef = coerceString(provenance?.sourceRef || claim?.sourceRef, '');

  if (opts.strictProvenance && !provenance) {
    return buildConflictResult({
      conflict: true,
      type: CONFLICT_TYPES.PROVENANCE_MISMATCH,
      recommendation: CONFLICT_RECOMMENDATIONS.REJECT,
      reason: 'Strict provenance requires provenance metadata.',
      workspaceId,
      provenanceId,
      sourceRef,
    });
  }

  if (provenance && normalizeWorkspaceId(provenance.workspaceId || workspaceId) !== workspaceId) {
    return buildConflictResult({
      conflict: true,
      type: CONFLICT_TYPES.WORKSPACE_SCOPE_MISMATCH,
      recommendation: CONFLICT_RECOMMENDATIONS.REJECT,
      reason: 'Claim workspace does not match provenance workspace.',
      workspaceId,
      provenanceId,
      sourceRef,
    });
  }

  if (!graph || !proposedEdge || !coerceString(proposedEdge.from) || !coerceString(proposedEdge.to) || !coerceString(proposedEdge.relation)) {
    return buildConflictResult({
      workspaceId,
      provenanceId,
      sourceRef,
    });
  }

  const from = coerceString(proposedEdge.from);
  const to = coerceString(proposedEdge.to);
  const relation = coerceString(proposedEdge.relation);
  const candidateConfidence = typeof proposedEdge.confidence === 'number'
    ? proposedEdge.confidence
    : typeof proposedEdge.weight === 'number'
      ? proposedEdge.weight
      : 0.5;
  const samePairEdges = typeof graph.getEdgesBetween === 'function'
    ? graph.getEdgesBetween(from, to, workspaceId)
    : (typeof graph.getEdges === 'function' ? graph.getEdges(from, workspaceId).filter(edge => edge.to === to) : []);
  const conflictingEdges = samePairEdges.filter((edge) => relationConflicts(relation, edge.relation) || relationConflicts(edge.relation, relation));
  const exactEdge = typeof graph.getEdge === 'function'
    ? graph.getEdge(from, to, relation, workspaceId)
    : null;

  if (exactEdge && !conflictingEdges.length) {
    return buildConflictResult({
      workspaceId,
      provenanceId,
      sourceRef,
    });
  }

  if (conflictingEdges.length > 0) {
    const existing = conflictingEdges[0];
    const conflictType = CAUSAL_RELATIONS.has(relation) || CAUSAL_RELATIONS.has(existing.relation)
      ? CONFLICT_TYPES.AGENT_VS_CAUSAL
      : (existing.provenanceId && provenanceId && existing.provenanceId !== provenanceId)
        ? CONFLICT_TYPES.AGENT_VS_AGENT
        : CONFLICT_TYPES.AGENT_VS_GRAPH;
    const sameSource = provenanceId && existing.provenanceId && provenanceId === existing.provenanceId;
    const recommendation = relationConflicts(relation, existing.relation) || relationConflicts(existing.relation, relation)
      ? CONFLICT_RECOMMENDATIONS.FLAG
      : CONFLICT_RECOMMENDATIONS.ACCEPT;
    const delta = Math.abs((existing.confidence ?? existing.weight ?? 0.5) - candidateConfidence);
    return buildConflictResult({
      conflict: true,
      type: conflictType,
      recommendation: recommendation === CONFLICT_RECOMMENDATIONS.ACCEPT && !sameSource
        ? CONFLICT_RECOMMENDATIONS.FLAG
        : recommendation,
      reason: 'Claim contradicts an existing graph-backed edge.',
      confidenceDelta: Number(delta.toFixed(2)),
      existingEvidence: summarizeExistingEvidence(conflictingEdges),
      proposedEvidence: summarizeProposedEvidence({ proposedEdge }),
      workspaceId,
      provenanceId,
      sourceRef,
    });
  }

  return buildConflictResult({
    workspaceId,
    provenanceId,
    sourceRef,
  });
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
function acceptCandidateClaimJournaled(kernel, candidate, conflict, built) {
  const workspaceId = candidate.workspaceId;
  const provenance = candidate.provenance && typeof candidate.provenance === 'object'
    ? candidate.provenance
    : kernel._backgroundProvenance('candidate_claim', workspaceId, {});
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
  const admission = kernel._evaluateLearnAdmission(proposalText, admissionOpts, provenance, workspaceId);

  if (!admission || admission.outcome !== 'allow') {
    // Not written canonically: the "accept" recommendation from conflict
    // detection is necessary but not sufficient -- admission (risk-based)
    // gets the final say, same as it does for learn() and other background
    // writes. Recorded as pending so it stays visible/reviewable rather
    // than silently disappearing.
    candidate.status = 'pending';
    if (kernel.graph && typeof kernel.graph.addCandidateClaim === 'function') {
      kernel.graph.addCandidateClaim(candidate);
    }
    kernel._appendAuditEvent({
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
        ...(admission ? kernel._admissionReceiptDetails(admission) : {}),
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
    kernel._appendAuditEvent({
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

function routeCandidateClaim(kernelOrGraph, claim, opts = {}) {
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
    const kernel = getJournalingKernel(kernelOrGraph);
    if (kernel) {
      return acceptCandidateClaimJournaled(kernel, candidate, conflict, built);
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
