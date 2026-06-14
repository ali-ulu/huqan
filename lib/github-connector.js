const crypto = require('crypto');
const { buildProvenance } = require('./provenance-ingest');
const { AUDIT_EVENTS } = require('./audit-log');
const {
  buildCandidateClaim,
  detectClaimConflict,
  normalizeCandidateClaim,
  routeCandidateClaim,
  CONFLICT_RECOMMENDATIONS,
} = require('./conflict-detector');

const GITHUB_SOURCE_TYPES = Object.freeze({
  merged_pr: 'merged_pr',
  open_pr: 'open_pr',
  closed_issue: 'closed_issue',
  open_issue: 'open_issue',
  release_tag: 'release_tag',
  commit_message: 'commit_message',
});

function nowIso() {
  return new Date().toISOString();
}

function sanitize(value, fallback = '') {
  const text = String(value == null ? '' : value).trim();
  return text || fallback;
}

function normalizeWorkspaceId(value, fallback = 'default') {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return fallback;
}

function getGraph(kernelOrGraph) {
  return kernelOrGraph && kernelOrGraph.graph ? kernelOrGraph.graph : kernelOrGraph;
}

function buildIdempotencyKey(item = {}, opts = {}) {
  const workspaceId = normalizeWorkspaceId(item.workspaceId || opts.workspaceId);
  const actor = sanitize(item.actor || opts.actor || 'github');
  const sourceRef = sanitize(item.sourceRef || opts.sourceRef);
  return `${sourceRef}|${workspaceId}|${actor}`;
}

function stableCandidateId(item = {}, opts = {}) {
  return `ghcand_${crypto.createHash('sha1').update(buildIdempotencyKey(item, opts), 'utf8').digest('hex').slice(0, 16)}`;
}

function parseRepo(repo = '') {
  const text = sanitize(repo);
  if (!text || !text.includes('/')) return { owner: '', name: '', repo: text };
  const [owner, name] = text.split('/', 2);
  return { owner, name, repo: `${owner}/${name}` };
}

function buildSourceRef(item = {}) {
  const repo = sanitize(item.repo);
  const subtype = sanitize(item.sourceSubType).toLowerCase();
  const number = item.number != null ? String(item.number).trim() : '';
  const sha = sanitize(item.sha);
  const tag = sanitize(item.tag);

  switch (subtype) {
    case GITHUB_SOURCE_TYPES.merged_pr:
    case GITHUB_SOURCE_TYPES.open_pr:
      return `github://${repo}/pull/${number || '0'}`;
    case GITHUB_SOURCE_TYPES.closed_issue:
    case GITHUB_SOURCE_TYPES.open_issue:
      return `github://${repo}/issues/${number || '0'}`;
    case GITHUB_SOURCE_TYPES.release_tag:
      return `github://${repo}/releases/tag/${tag || 'unknown'}`;
    case GITHUB_SOURCE_TYPES.commit_message:
      return `github://${repo}/commit/${sha || 'unknown'}`;
    default: {
      const token = number || sha || tag || sanitize(item.title).toLowerCase().replace(/\s+/g, '-').slice(0, 32) || 'item';
      return `github://${repo}/items/${subtype || 'unknown'}/${token}`;
    }
  }
}

function buildClaimText(item = {}) {
  const repo = sanitize(item.repo);
  const title = sanitize(item.title, 'Untitled');
  const subtype = sanitize(item.sourceSubType).toLowerCase();
  const number = sanitize(item.number);
  const sha = sanitize(item.sha);
  const tag = sanitize(item.tag);

  switch (subtype) {
    case GITHUB_SOURCE_TYPES.merged_pr:
      return `PR ${number || '?'} merged in ${repo}: ${title}`;
    case GITHUB_SOURCE_TYPES.open_pr:
      return `PR ${number || '?'} opened in ${repo}: ${title}`;
    case GITHUB_SOURCE_TYPES.closed_issue:
      return `Issue ${number || '?'} closed in ${repo}: ${title}`;
    case GITHUB_SOURCE_TYPES.open_issue:
      return `Issue ${number || '?'} opened in ${repo}: ${title}`;
    case GITHUB_SOURCE_TYPES.release_tag:
      return `Release ${tag || '?'} published in ${repo}: ${title}`;
    case GITHUB_SOURCE_TYPES.commit_message:
      return `Commit ${sha || '?'} in ${repo}: ${title}`;
    default:
      return `${subtype || 'github'} item in ${repo}: ${title}`;
  }
}

function normalizeGitHubItem(input = {}, opts = {}) {
  const sourceSubType = sanitize(input.sourceSubType || opts.sourceSubType).toLowerCase();
  const repo = sanitize(input.repo || opts.repo);
  if (!repo) {
    throw new Error('repo is required for GitHub ingestion');
  }
  if (!sourceSubType) {
    throw new Error('sourceSubType is required for GitHub ingestion');
  }
  const workspaceId = normalizeWorkspaceId(input.workspaceId || opts.workspaceId);
  const actor = sanitize(input.actor || opts.actor || `github:${repo || 'unknown'}`, `github:${repo || 'unknown'}`);
  const timestamp = sanitize(input.timestamp || opts.timestamp, nowIso()) || nowIso();
  const title = sanitize(input.title || opts.title || '', '');
  const body = sanitize(input.body || opts.body || '', '');
  const url = sanitize(input.url || opts.url || '', '');
  const labels = Array.isArray(input.labels) ? [...input.labels] : Array.isArray(opts.labels) ? [...opts.labels] : [];
  const claim = buildClaimText({ ...input, sourceSubType, repo, title });
  const sourceRef = sanitize(input.sourceRef || opts.sourceRef || buildSourceRef({ ...input, sourceSubType, repo, title }), '');
  const sourceTitle = title || claim;
  const sourceType = 'github';
  const proposedEdge = input.proposedEdge || opts.proposedEdge || (input.subject || input.relation || input.object
    ? {
        from: input.subject || input.from || `github:${repo || 'unknown'}`,
        relation: input.relation || 'reports',
        to: input.object || input.to || claim,
        confidence: typeof input.confidence === 'number' ? input.confidence : undefined,
        sourceRef,
        workspaceId,
      }
    : {
        from: `github:${repo || 'unknown'}`,
        relation: 'reports',
        to: claim,
        sourceRef,
        workspaceId,
      });

  return {
    sourceType,
    sourceSubType,
    repo,
    ...parseRepo(repo),
    number: input.number != null ? input.number : opts.number,
    sha: sanitize(input.sha || opts.sha, ''),
    tag: sanitize(input.tag || opts.tag, ''),
    title: sourceTitle,
    sourceTitle,
    url,
    body,
    labels,
    actor,
    timestamp,
    workspaceId,
    sourceRef,
    claim,
    proposedEdge,
  };
}

function buildGitHubProvenance(input = {}, opts = {}) {
  const normalized = normalizeGitHubItem(input, opts);
  const provenanceInput = {
    provenanceId: input.provenanceId || opts.provenanceId || '',
    sourceRef: normalized.sourceRef,
    sourceTitle: normalized.sourceTitle,
    sourceType: 'github',
    sourceSubType: normalized.sourceSubType,
    actor: normalized.actor,
    timestamp: normalized.timestamp,
    confidence: input.confidence ?? opts.confidence,
    workspaceId: normalized.workspaceId,
  };

  const provenanceBundle = buildProvenance(provenanceInput, {
    ...opts,
    sourceType: 'github',
    sourceSubType: normalized.sourceSubType,
    sourceRef: normalized.sourceRef,
    sourceTitle: normalized.sourceTitle,
    actor: normalized.actor,
    timestamp: normalized.timestamp,
    workspaceId: normalized.workspaceId,
  });

  const warnings = [...provenanceBundle.warnings];
  if (!Object.prototype.hasOwnProperty.call(GITHUB_SOURCE_TYPES, normalized.sourceSubType)) {
    warnings.push(`unknown GitHub sourceSubType: ${normalized.sourceSubType || 'unknown'}`);
  }

  return {
    provenance: provenanceBundle.provenance,
    warnings,
    normalized,
    trustPolicy: provenanceBundle.policy,
  };
}

function appendAudit(kernelOrGraph, event, provenance, workspaceId) {
  const payload = {
    ...event,
    workspaceId,
  };
  if (kernelOrGraph && typeof kernelOrGraph._appendAuditEvent === 'function') {
    return kernelOrGraph._appendAuditEvent(payload, provenance, workspaceId);
  }
  if (kernelOrGraph && typeof kernelOrGraph.appendAuditEvent === 'function') {
    return kernelOrGraph.appendAuditEvent(payload, provenance ? { provenance, workspaceId } : { workspaceId });
  }
  return null;
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
    const routed = routeCandidateClaim(kernelOrGraph, {
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
    });

    appendAudit(kernelOrGraph, {
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
  GITHUB_SOURCE_TYPES,
  buildGitHubProvenance,
  normalizeGitHubItem,
  ingestGitHubItem,
  ingestGitHubItems,
};
