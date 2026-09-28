const { AUDIT_EVENTS } = require('./audit-log');
const { normalizeWorkspaceId } = require('./workspace-id');
const {
  getGraph,
  nowIso,
  sanitize,
  stableCandidateId,
  normalizeGitHubItem,
} = require('./github-connector-normalize');
const { buildGitHubProvenance } = require('./github-connector-provenance');
const {
  buildCandidateClaim,
  detectClaimConflict,
  normalizeCandidateClaim,
  routeCandidateClaim,
  CONFLICT_RECOMMENDATIONS,
} = require('./conflict-detector');

function appendAudit(kernelOrGraph, event, provenance, workspaceId) {
  const payload = { ...event, workspaceId };
  const graph = getGraph(kernelOrGraph);
  if (!graph || typeof graph.appendAuditEvent !== 'function') return null;
  const opts = provenance ? { provenance, workspaceId } : { workspaceId };
  const append = () => graph.appendAuditEvent(payload, opts);

  if (graph === kernelOrGraph) return append();
  try { return append(); } catch (error) {
    console.error('[Kernel] Audit log error:', error.message);
    return null;
  }
}

function findExistingImport(graph, normalized) {
  if (!graph || typeof graph.getCandidateClaims !== 'function') return null;
  const workspaceId = normalizeWorkspaceId(normalized.workspaceId);
  const sourceRef = normalized.sourceRef;
  const actor = normalized.actor;
  const candidates = graph.getCandidateClaims({ workspaceId, sourceRef });
  return candidates.find((candidate) => {
    const candidateActor = sanitize(candidate.provenance?.actor || candidate.reviewedBy || '');
    const candidateSourceRef = sanitize(candidate.provenance?.sourceRef || '');
    return candidateSourceRef === sourceRef && candidateActor === actor;
  }) || null;
}

function buildImportAuditDetails(normalized, provenance, candidateId, extras = {}) {
  return {
    connector: 'github',
    repo: normalized.repo,
    sourceSubType: normalized.sourceSubType,
    sourceRef: normalized.sourceRef,
    candidateId,
    provenanceId: provenance.provenanceId,
    trustPolicyVersion: provenance.trustPolicyVersion,
    duplicate: Boolean(extras.duplicate),
    ...extras,
  };
}

function buildAdmissionResult(outcome, extras = {}) {
  return {
    outcome,
    ...extras,
  };
}

function routeAsPendingCandidate(kernelOrGraph, normalized, provenance, opts = {}) {
  const candidate = normalizeCandidateClaim({
    candidateId: stableCandidateId(normalized, opts),
    claim: normalized.claim,
    proposedEdge: normalized.proposedEdge,
    provenance,
    workspaceId: normalized.workspaceId,
    createdAt: normalized.timestamp,
    reviewedBy: normalized.actor,
    warnings: opts.warnings || [],
  });

  candidate.provenance = provenance;
  candidate.workspaceId = normalized.workspaceId;
  candidate.proposedEdge = candidate.proposedEdge || normalized.proposedEdge || null;

  const graph = getGraph(kernelOrGraph);
  const conflict = detectClaimConflict(kernelOrGraph, candidate, {
    workspaceId: normalized.workspaceId,
    strictProvenance: opts.strictProvenance,
  });

  candidate.conflict = conflict;
  candidate.recommendation = conflict.recommendation;

  if (conflict.recommendation === CONFLICT_RECOMMENDATIONS.REJECT) {
    candidate.status = 'rejected';
    candidate.reviewedAt = nowIso();
    candidate.reviewedBy = normalized.actor;
  } else if (conflict.recommendation === CONFLICT_RECOMMENDATIONS.FLAG && conflict.conflict) {
    candidate.status = 'pending';
  } else {
    candidate.status = 'pending';
  }

  if (graph && typeof graph.addCandidateClaim === 'function') {
    graph.addCandidateClaim(candidate, { workspaceId: normalized.workspaceId });
  }

  if (conflict.conflict) {
    appendAudit(kernelOrGraph, {
      eventType: AUDIT_EVENTS.CONFLICT_DETECTED,
      targetType: 'candidate_claim',
      targetId: candidate.candidateId,
      details: buildImportAuditDetails(normalized, provenance, candidate.candidateId, {
        reason: conflict.reason,
        conflictType: conflict.type,
      }),
    }, provenance, normalized.workspaceId);
  }

  if (candidate.status === 'rejected') {
    appendAudit(kernelOrGraph, {
      eventType: AUDIT_EVENTS.CLAIM_REJECTED,
      targetType: 'candidate_claim',
      targetId: candidate.candidateId,
      details: buildImportAuditDetails(normalized, provenance, candidate.candidateId),
    }, provenance, normalized.workspaceId);
  } else if (conflict.conflict) {
    appendAudit(kernelOrGraph, {
      eventType: AUDIT_EVENTS.CLAIM_FLAGGED,
      targetType: 'candidate_claim',
      targetId: candidate.candidateId,
      details: buildImportAuditDetails(normalized, provenance, candidate.candidateId, {
        reason: conflict.reason,
      }),
    }, provenance, normalized.workspaceId);
  }

  return {
    candidate,
    conflict,
    warnings: opts.warnings || [],
    normalized,
    provenance,
    admission: buildAdmissionResult(candidate.status === 'rejected' ? 'rejected' : 'candidate', {
      targetType: 'candidate_claim',
      targetId: candidate.candidateId,
      workspaceId: normalized.workspaceId,
      provenanceId: provenance?.provenanceId || '',
      sourceRef: provenance?.sourceRef || normalized.sourceRef || '',
      graphWrite: false,
    }),
  };
}

function ingestGitHubItem(kernelOrGraph, item = {}, opts = {}) {
  const normalized = normalizeGitHubItem(item, opts);
  const workspaceId = normalizeWorkspaceId(normalized.workspaceId);
  const built = buildGitHubProvenance(normalized, opts);
  const provenance = built.provenance;
  const graph = getGraph(kernelOrGraph);
  const accept = opts.accept === true;
  const conflictPolicy = opts.conflictPolicy || 'route';
  const existing = findExistingImport(graph, normalized);
  const candidateId = existing?.candidateId || stableCandidateId(normalized, opts);
  const baseAuditDetails = buildImportAuditDetails(normalized, provenance, candidateId, {
    duplicate: Boolean(existing),
  });

  if (existing) {
    appendAudit(kernelOrGraph, {
      eventType: AUDIT_EVENTS.IMPORTED,
      targetType: 'candidate_claim',
      targetId: candidateId,
      details: baseAuditDetails,
    }, provenance, workspaceId);
    return {
      candidate: existing,
      conflict: existing.conflict || null,
      warnings: built.warnings,
      provenance,
      normalized,
      duplicate: true,
      admission: buildAdmissionResult('skipped', {
        targetType: 'candidate_claim',
        targetId: candidateId,
        workspaceId,
        provenanceId: provenance?.provenanceId || '',
        sourceRef: provenance?.sourceRef || normalized.sourceRef || '',
        graphWrite: false,
        reason: 'duplicate',
      }),
    };
  }

  if (accept && conflictPolicy === 'route') {
    const route = typeof kernelOrGraph?.ingestCandidateClaim === 'function' ? kernelOrGraph.ingestCandidateClaim.bind(kernelOrGraph) : (input, routeOpts) => routeCandidateClaim(kernelOrGraph, input, routeOpts);
    const routed = route({
      candidateId,
      claim: normalized.claim,
      subject: normalized.proposedEdge?.from,
      relation: normalized.proposedEdge?.relation,
      object: normalized.proposedEdge?.to,
      proposedEdge: normalized.proposedEdge,
      provenance,
      workspaceId,
      actor: normalized.actor,
      sourceRef: normalized.sourceRef,
      sourceType: 'github',
    }, {
      ...opts,
      workspaceId,
      strictProvenance: opts.strictProvenance,
      reviewedBy: normalized.actor,
      actor: normalized.actor,
    }); appendAudit(kernelOrGraph, {
      eventType: AUDIT_EVENTS.IMPORTED,
      targetType: 'candidate_claim',
      targetId: routed.candidate.candidateId,
      details: buildImportAuditDetails(normalized, provenance, routed.candidate.candidateId, {
        routed: true,
        duplicate: false,
      }),
    }, provenance, workspaceId);

    return {
      ...routed,
      provenance,
      normalized,
      duplicate: false,
      admission: buildAdmissionResult('admitted', {
        targetType: 'candidate_claim',
        targetId: routed.candidate.candidateId,
        workspaceId,
        provenanceId: provenance?.provenanceId || '',
        sourceRef: provenance?.sourceRef || normalized.sourceRef || '',
        graphWrite: true,
        canonical: true,
      }),
    };
  }

  const routed = routeAsPendingCandidate(kernelOrGraph, normalized, provenance, {
    ...opts,
    warnings: built.warnings,
  });

  appendAudit(kernelOrGraph, {
    eventType: AUDIT_EVENTS.IMPORTED,
    targetType: 'candidate_claim',
    targetId: routed.candidate.candidateId,
    details: buildImportAuditDetails(normalized, provenance, routed.candidate.candidateId, {
      routed: false,
      duplicate: false,
      status: routed.candidate.status,
    }),
  }, provenance, workspaceId);

  return {
    ...routed,
    provenance,
    normalized,
    duplicate: false,
    admission: routed.admission || buildAdmissionResult(routed.candidate.status === 'rejected' ? 'rejected' : 'candidate', {
      targetType: 'candidate_claim',
      targetId: routed.candidate.candidateId,
      workspaceId,
      provenanceId: provenance?.provenanceId || '',
      sourceRef: provenance?.sourceRef || normalized.sourceRef || '',
      graphWrite: false,
    }),
  };
}

function ingestGitHubItems(kernelOrGraph, items = [], opts = {}) {
  const results = [];
  for (const item of items) {
    results.push(ingestGitHubItem(kernelOrGraph, item, opts));
  }
  return results;
}

module.exports = {
  appendAudit,
  findExistingImport,
  buildImportAuditDetails,
  buildAdmissionResult,
  routeAsPendingCandidate,
  ingestGitHubItem,
  ingestGitHubItems,
};
