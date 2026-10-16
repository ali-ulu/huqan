'use strict';

// Claim-shape side of lib/conflict-detector.js (#2120): conflict vocabularies,
// small coercion helpers, edge refs and candidate-claim construction.
// Moved verbatim; detection lives in lib/conflict-detect.js and routing stays
// in the entry.
const { randomUUID } = require('crypto');
const { buildProvenance } = require('./provenance-ingest');
const { normalizeWorkspaceId } = require('./workspace-id');
const { isPlainObject } = require('./is-plain-object');

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
    // Edge provenance nests under edge.provenance; only ingress inputs carry a
    // flat id. This is the one read of it (see the AGENT_VS_AGENT branch).
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

  const normalized = {
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

  // #3568 (R49): the K0/K1 cognition step only a hypothesis candidate carries.
  // Listed conditionally so a claim that has no cognition step keeps exactly the
  // shape it had before -- an unrelated candidate is not given four null fields
  // that read as "measured none". A re-sighting reads `frameComparison` back to
  // decide whether two frames may merge.
  if (candidate.cognitiveMessage !== undefined) {
    normalized.cognitiveMessage = isPlainObject(candidate.cognitiveMessage) ? candidate.cognitiveMessage : null;
  }
  if (candidate.knowledgeObject !== undefined) {
    normalized.knowledgeObject = isPlainObject(candidate.knowledgeObject) ? candidate.knowledgeObject : null;
  }
  if (candidate.cognitionWarnings !== undefined) {
    normalized.cognitionWarnings = Array.isArray(candidate.cognitionWarnings) ? [...candidate.cognitionWarnings] : [];
  }
  if (candidate.frameComparison !== undefined) {
    normalized.frameComparison = isPlainObject(candidate.frameComparison) ? candidate.frameComparison : null;
  }
  return normalized;
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

module.exports = {
  CONFLICT_TYPES,
  CONFLICT_RECOMMENDATIONS,
  RELATION_CONFLICTS,
  CAUSAL_RELATIONS,
  nowIso,
  safeJsonParse,
  coerceString,
  relationConflicts,
  edgeRef,
  normalizeCandidateClaim,
  buildCandidateClaim,
};
