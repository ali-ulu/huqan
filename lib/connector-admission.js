const crypto = require('crypto');
const { buildProvenance } = require('./provenance-ingest');
const { routeCandidateClaim } = require('./conflict-detector');

function text(value) {
  return String(value == null ? '' : value).trim();
}

function fail(code, message) {
  return {
    ok: false,
    admitted: false,
    candidate: null,
    conflict: null,
    error: { code, message },
  };
}

function deterministicProvenanceId(input) {
  const payload = [
    input.workspaceId,
    input.sourceType,
    input.sourceRef,
    input.from,
    input.relation,
    input.to,
  ].join('|');
  return `prov_connector_${crypto.createHash('sha1').update(payload, 'utf8').digest('hex').slice(0, 16)}`;
}

function buildConnectorProvenance(input = {}) {
  const supplied = input.provenance && typeof input.provenance === 'object'
    ? input.provenance
    : {};
  const normalized = {
    provenanceId: text(supplied.provenanceId || input.provenanceId),
    sourceRef: text(supplied.sourceRef || input.sourceRef),
    sourceTitle: text(supplied.sourceTitle || input.sourceTitle),
    sourceType: text(supplied.sourceType || input.sourceType),
    sourceSubType: text(supplied.sourceSubType || input.sourceSubType),
    actor: text(supplied.actor || input.actor),
    timestamp: text(supplied.timestamp || input.timestamp),
    confidence: supplied.confidence ?? input.confidence,
    workspaceId: text(supplied.workspaceId || input.workspaceId),
  };

  const missing = ['sourceRef', 'sourceTitle', 'sourceType', 'actor', 'timestamp', 'workspaceId']
    .filter(field => !normalized[field]);
  if (typeof normalized.confidence !== 'number' || Number.isNaN(normalized.confidence)) {
    missing.push('confidence');
  }
  if (missing.length > 0) {
    const error = new Error(`connector provenance missing: ${missing.join(', ')}`);
    error.code = 'CONNECTOR_PROVENANCE_REQUIRED';
    throw error;
  }

  if (!normalized.provenanceId) {
    normalized.provenanceId = deterministicProvenanceId({ ...input, ...normalized });
  }

  return buildProvenance(normalized, {
    strictProvenance: true,
    sourceType: normalized.sourceType,
    sourceSubType: normalized.sourceSubType,
    sourceRef: normalized.sourceRef,
    sourceTitle: normalized.sourceTitle,
    actor: normalized.actor,
    timestamp: normalized.timestamp,
    confidence: normalized.confidence,
    workspaceId: normalized.workspaceId,
  });
}

function admitConnectorEdge(kernel, input = {}) {
  const from = text(input.from);
  const to = text(input.to);
  const relation = text(input.relation);
  if (!kernel || !kernel.graph || !from || !to || !relation) {
    return fail('CONNECTOR_EDGE_INVALID', 'connector edge requires kernel, from, to, and relation');
  }

  let built;
  try {
    built = buildConnectorProvenance({ ...input, from, to, relation });
  } catch (error) {
    return fail(error.code || 'CONNECTOR_PROVENANCE_REQUIRED', error.message);
  }

  const provenance = built.provenance;
  const workspaceId = provenance.workspaceId;
  const routed = routeCandidateClaim(kernel, {
    claim: text(input.claim) || `${from} ${relation} ${to}`,
    proposedEdge: {
      from,
      to,
      relation,
      confidence: input.confidence,
      workspaceId,
      source: text(input.source) || 'connector',
      sourceRef: provenance.sourceRef,
      evidence: Array.isArray(input.evidence) ? input.evidence : [],
    },
    provenance,
    workspaceId,
    actor: provenance.actor,
  }, {
    strictProvenance: true,
    workspaceId,
    actor: provenance.actor,
    reviewedBy: provenance.actor,
  });

  if (routed.candidate.status === 'accepted' && typeof kernel.graph.getEdge === 'function') {
    const edge = kernel.graph.getEdge(from, to, relation, workspaceId);
    if (edge) {
      kernel.graph.addEdge(from, to, relation, {
        workspaceId,
        weight: edge.weight,
        confidence: input.confidence,
        source: text(input.source) || 'connector',
        sourceRef: provenance.sourceRef,
        sessionId: text(input.sessionId),
        sourceType: text(input.sourceType) || provenance.sourceType,
        evidenceType: text(input.evidenceType),
        companyMode: input.companyMode === true,
        evidence: Array.isArray(input.evidence) ? input.evidence : [],
        createdAt: text(input.createdAt),
        provenance,
      });
    }
  }

  return {
    ok: true,
    admitted: routed.candidate.status === 'accepted',
    candidate: routed.candidate,
    conflict: routed.conflict,
    provenance,
    warnings: [...built.warnings, ...(routed.warnings || [])],
  };
}

module.exports = {
  admitConnectorEdge,
  buildConnectorProvenance,
};
