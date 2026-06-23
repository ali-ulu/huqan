const {
  buildCandidateClaim,
  detectClaimConflict,
  routeCandidateClaim,
  CONFLICT_RECOMMENDATIONS,
} = require('./conflict-detector');
const { AUDIT_EVENTS } = require('./audit-log');

function nowIso() {
  return new Date().toISOString();
}

function text(value, fallback = '') {
  const raw = String(value == null ? '' : value).trim();
  return raw || fallback;
}

function workspace(value) {
  return text(value, 'default');
}

function graphOf(kernelOrGraph) {
  return kernelOrGraph && kernelOrGraph.graph ? kernelOrGraph.graph : kernelOrGraph;
}

function normalizeSourceType(value) {
  const raw = text(value, 'import').toLowerCase();
  if (raw === 'github') return 'github';
  if (raw === 'markdown') return 'document';
  if (raw === 'repo') return 'github';
  if (raw === 'document' || raw === 'api' || raw === 'user' || raw === 'agent' || raw === 'system' || raw === 'import' || raw === 'llm') {
    return raw;
  }
  return 'import';
}

function appendAudit(kernelOrGraph, event, provenance, workspaceId) {
  const payload = { ...event, workspaceId };
  if (kernelOrGraph && typeof kernelOrGraph._appendAuditEvent === 'function') {
    return kernelOrGraph._appendAuditEvent(payload, provenance, workspaceId);
  }
  const graph = graphOf(kernelOrGraph);
  if (graph && typeof graph.appendAuditEvent === 'function') {
    return graph.appendAuditEvent(payload, provenance ? { provenance, workspaceId } : { workspaceId });
  }
  return null;
}

function importDetails(candidate, input, extra = {}) {
  return {
    connector: text(input.connector, 'repo-memory'),
    sourceType: text(input.sourceType, 'connector'),
    sourceSubType: text(input.sourceSubType, ''),
    sourceRef: text(input.sourceRef, ''),
    candidateId: candidate.candidateId,
    provenanceId: text(candidate.provenance?.provenanceId, ''),
    trustPolicyVersion: text(candidate.provenance?.trustPolicyVersion, ''),
    ...extra,
  };
}

function routeConnectorCandidate(kernelOrGraph, input = {}, opts = {}) {
  const workspaceId = workspace(input.workspaceId || opts.workspaceId);
  const accept = input.accept === true || opts.accept === true;
  const actor = text(input.actor || opts.actor, 'connector');
  const sourceRef = text(input.sourceRef || opts.sourceRef);

  if (!sourceRef && (input.strictProvenance === true || opts.strictProvenance === true)) {
    throw new Error('sourceRef is required for strict connector admission');
  }

  const baseClaim = {
    claim: input.claim || input.text || input.statement || input.sourceTitle || sourceRef,
    proposedEdge: input.proposedEdge,
    workspaceId,
    sourceRef,
    sourceTitle: input.sourceTitle || input.title || sourceRef,
    sourceType: normalizeSourceType(input.sourceType || opts.sourceType || 'import'),
    sourceSubType: input.sourceSubType || opts.sourceSubType || '',
    actor,
    timestamp: input.timestamp || opts.timestamp || nowIso(),
    confidence: input.confidence ?? opts.confidence,
  };

  if (accept) {
    const routed = routeCandidateClaim(kernelOrGraph, baseClaim, {
      ...opts,
      workspaceId,
      actor,
      reviewedBy: actor,
      strictProvenance: input.strictProvenance === true || opts.strictProvenance === true,
    });
    appendAudit(kernelOrGraph, {
      eventType: AUDIT_EVENTS.IMPORTED,
      targetType: 'candidate_claim',
      targetId: routed.candidate.candidateId,
      details: importDetails(routed.candidate, baseClaim, { routed: true, status: routed.candidate.status }),
    }, routed.candidate.provenance, workspaceId);
    return routed;
  }

  const built = buildCandidateClaim(baseClaim, {
    ...opts,
    workspaceId,
    actor,
    strictProvenance: input.strictProvenance === true || opts.strictProvenance === true,
  });
  const candidate = built.candidate;
  const conflict = detectClaimConflict(kernelOrGraph, candidate, { workspaceId });

  candidate.conflict = conflict;
  candidate.recommendation = conflict.recommendation;
  candidate.status = conflict.recommendation === CONFLICT_RECOMMENDATIONS.REJECT ? 'rejected' : 'pending';
  if (candidate.status === 'rejected') {
    candidate.reviewedAt = nowIso();
    candidate.reviewedBy = actor;
  }

  const graph = graphOf(kernelOrGraph);
  if (graph && typeof graph.addCandidateClaim === 'function') {
    graph.addCandidateClaim(candidate, { workspaceId });
  }

  if (conflict.conflict) {
    appendAudit(kernelOrGraph, {
      eventType: AUDIT_EVENTS.CONFLICT_DETECTED,
      targetType: 'candidate_claim',
      targetId: candidate.candidateId,
      details: importDetails(candidate, baseClaim, {
        reason: conflict.reason,
        conflictType: conflict.type,
        recommendation: conflict.recommendation,
      }),
    }, candidate.provenance, workspaceId);
    appendAudit(kernelOrGraph, {
      eventType: AUDIT_EVENTS.CLAIM_FLAGGED,
      targetType: 'candidate_claim',
      targetId: candidate.candidateId,
      details: importDetails(candidate, baseClaim, {
        reason: conflict.reason,
        recommendation: conflict.recommendation,
      }),
    }, candidate.provenance, workspaceId);
  }

  if (candidate.status === 'rejected') {
    appendAudit(kernelOrGraph, {
      eventType: AUDIT_EVENTS.CLAIM_REJECTED,
      targetType: 'candidate_claim',
      targetId: candidate.candidateId,
      details: importDetails(candidate, baseClaim, { status: 'rejected' }),
    }, candidate.provenance, workspaceId);
  }

  appendAudit(kernelOrGraph, {
    eventType: AUDIT_EVENTS.IMPORTED,
    targetType: 'candidate_claim',
    targetId: candidate.candidateId,
    details: importDetails(candidate, baseClaim, { routed: false, status: candidate.status }),
  }, candidate.provenance, workspaceId);

  return {
    candidate,
    conflict,
    warnings: built.warnings,
  };
}

module.exports = {
  routeConnectorCandidate,
};
