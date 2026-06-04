const { randomUUID } = require('crypto');
const { normalizeAuditEvent } = require('./audit-log');
const { normalizeCandidateClaim } = require('./conflict-detector');
const { normalizeCausalVerdict } = require('./causal/causal-verdict');

const TRUST_STATUSES = Object.freeze([
  'canonical',
  'pending',
  'flagged',
  'rejected',
  'unknown',
]);

function nowIso() {
  return new Date().toISOString();
}

function normalizeWorkspaceId(value, fallback = 'default') {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return fallback;
}

function coerceString(value, fallback = '') {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value === 0) return '0';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}

function safeJsonClone(value, fallback = null) {
  if (value === undefined) return fallback;
  if (value === null) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return fallback;
  }
}

function getGraph(target) {
  return target && target.graph ? target.graph : target;
}

function provenanceShape(provenance, workspaceId) {
  if (!provenance || typeof provenance !== 'object') return null;
  return {
    provenanceId: coerceString(provenance.provenanceId, ''),
    sourceRef: coerceString(provenance.sourceRef, ''),
    sourceTitle: coerceString(provenance.sourceTitle, ''),
    sourceType: coerceString(provenance.sourceType, ''),
    sourceSubType: coerceString(provenance.sourceSubType, ''),
    actor: coerceString(provenance.actor, 'system'),
    timestamp: coerceString(provenance.timestamp, nowIso()),
    confidence: typeof provenance.confidence === 'number' ? provenance.confidence : 0.5,
    workspaceId: normalizeWorkspaceId(provenance.workspaceId || workspaceId),
    trustPolicyVersion: coerceString(provenance.trustPolicyVersion, ''),
  };
}

function publicCandidateClaim(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const normalized = normalizeCandidateClaim(candidate);
  return {
    candidateId: normalized.candidateId,
    claim: normalized.claim,
    proposedEdge: safeJsonClone(normalized.proposedEdge, null),
    provenance: provenanceShape(normalized.provenance, normalized.workspaceId),
    conflict: safeJsonClone(normalized.conflict, null),
    recommendation: normalized.recommendation,
    status: normalized.status,
    workspaceId: normalizeWorkspaceId(normalized.workspaceId),
    createdAt: normalized.createdAt,
    reviewedAt: normalized.reviewedAt,
    reviewedBy: normalized.reviewedBy,
    warnings: Array.isArray(normalized.warnings) ? [...normalized.warnings] : [],
  };
}

function publicAuditEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const normalized = normalizeAuditEvent(event);
  return {
    auditId: normalized.auditId,
    eventType: normalized.eventType,
    targetType: normalized.targetType,
    targetId: normalized.targetId,
    workspaceId: normalizeWorkspaceId(normalized.workspaceId),
    actor: normalized.actor,
    timestamp: normalized.timestamp,
    sourceRef: normalized.sourceRef,
    provenanceId: normalized.provenanceId,
    trustPolicyVersion: normalized.trustPolicyVersion,
    details: safeJsonClone(normalized.details, {}),
  };
}

function normalizeTrustReceipt(receipt = {}) {
  const auditTrail = Array.isArray(receipt.auditTrail)
    ? receipt.auditTrail.map(publicAuditEvent).filter(Boolean)
    : [];
  auditTrail.sort((a, b) => {
    const timestampDiff = String(a.timestamp || '').localeCompare(String(b.timestamp || ''));
    if (timestampDiff !== 0) return timestampDiff;
    return String(a.auditId || '').localeCompare(String(b.auditId || ''));
  });

  const candidateClaim = receipt.candidateClaim ? publicCandidateClaim(receipt.candidateClaim) : null;
  const provenance = provenanceShape(receipt.provenance, receipt.workspaceId)
    || candidateClaim?.provenance
    || null;
  const workspaceId = normalizeWorkspaceId(receipt.workspaceId || provenance?.workspaceId || candidateClaim?.workspaceId);
  const status = TRUST_STATUSES.includes(receipt.status) ? receipt.status : 'unknown';
  const trustPolicyVersion = coerceString(
    receipt.trustPolicyVersion || provenance?.trustPolicyVersion || candidateClaim?.provenance?.trustPolicyVersion,
    '',
  );

  return {
    receiptId: coerceString(receipt.receiptId, randomUUID()),
    targetType: coerceString(receipt.targetType, ''),
    targetId: coerceString(receipt.targetId, ''),
    claim: coerceString(receipt.claim, ''),
    status,
    workspaceId,
    provenance,
    trustPolicyVersion,
    confidence: typeof receipt.confidence === 'number'
      ? receipt.confidence
      : provenance?.confidence ?? candidateClaim?.provenance?.confidence ?? 0.5,
    auditTrail,
    conflict: safeJsonClone(receipt.conflict, null),
    candidateClaim,
    canonical: Boolean(receipt.canonical),
    generatedAt: coerceString(receipt.generatedAt, nowIso()),
  };
}

function matchesProvenanceFilters(provenance, filters = {}) {
  if (!provenance) return false;
  if (filters.provenanceId && provenance.provenanceId !== filters.provenanceId) return false;
  if (filters.sourceRef && provenance.sourceRef !== filters.sourceRef) return false;
  if (filters.sourceType && provenance.sourceType !== filters.sourceType) return false;
  if (filters.actor && provenance.actor !== filters.actor) return false;
  if (filters.sourceSubType && provenance.sourceSubType !== filters.sourceSubType) return false;
  return true;
}

function matchesWorkspace(itemWorkspaceId, filtersWorkspaceId, crossWorkspace = false) {
  if (crossWorkspace) return true;
  return normalizeWorkspaceId(itemWorkspaceId) === normalizeWorkspaceId(filtersWorkspaceId);
}

function matchesCanonicalTarget(candidate, canonicalRecord) {
  if (!candidate || !canonicalRecord) return false;
  const targetId = coerceString(canonicalRecord.targetId, '');
  if (!targetId) return false;
  const proposed = candidate.proposedEdge || {};
  const candidateTargetIds = new Set([
    candidate.candidateId,
    proposed.from,
    proposed.to,
    proposed.from && proposed.to && proposed.relation
      ? `${proposed.from}|${proposed.relation}|${proposed.to}`
      : '',
  ].filter(Boolean));
  return candidateTargetIds.has(targetId);
}

function recordSort(a, b, order = 'asc') {
  const timestampDiff = String(a.timestamp || a.createdAt || a.created_at || '').localeCompare(String(b.timestamp || b.createdAt || b.created_at || ''));
  if (timestampDiff !== 0) return order === 'desc' ? -timestampDiff : timestampDiff;
  const idA = String(a.targetId || a.candidateId || a.auditId || a.provenance?.provenanceId || '');
  const idB = String(b.targetId || b.candidateId || b.auditId || b.provenance?.provenanceId || '');
  const diff = idA.localeCompare(idB);
  return order === 'desc' ? -diff : diff;
}

function queryProvenance(target, filters = {}) {
  const graph = getGraph(target);
  if (!graph) return [];
  const workspaceId = normalizeWorkspaceId(filters.workspaceId);
  const crossWorkspace = filters.crossWorkspace === true;
  const targetId = coerceString(filters.targetId, '');
  const records = [];
  const nodes = Object.values(graph._nodes || {});
  const edges = Array.isArray(graph._edges) ? graph._edges : [];
  const candidates = crossWorkspace
    ? (graph._candidateClaims || [])
    : (typeof graph.getCandidateClaims === 'function' ? graph.getCandidateClaims({ workspaceId }) : []);

  for (const node of nodes) {
    if (!matchesWorkspace(node.workspaceId, workspaceId, crossWorkspace)) continue;
    if (!node.provenance) continue;
    if (!matchesProvenanceFilters(node.provenance, filters)) continue;
    if (targetId && node.id !== targetId) continue;
    records.push({
      kind: 'node',
      targetType: 'node',
      targetId: node.id,
      claim: node.label || node.id,
      status: 'canonical',
      canonical: true,
      workspaceId: normalizeWorkspaceId(node.workspaceId),
      confidence: typeof node.provenance.confidence === 'number' ? node.provenance.confidence : node.weight ?? 0.5,
      provenance: provenanceShape(node.provenance, node.workspaceId),
      trustPolicyVersion: coerceString(node.provenance?.trustPolicyVersion, ''),
      createdAt: node.created_at || node.last_seen || '',
    });
  }

  for (const edge of edges) {
    if (!matchesWorkspace(edge.workspaceId, workspaceId, crossWorkspace)) continue;
    if (!edge.provenance) continue;
    if (!matchesProvenanceFilters(edge.provenance, filters)) continue;
    const compositeId = `${edge.from}|${edge.relation}|${edge.to}`;
    if (targetId && targetId !== compositeId && targetId !== edge.from && targetId !== edge.to) continue;
    records.push({
      kind: 'edge',
      targetType: 'edge',
      targetId: compositeId,
      claim: `${edge.from} --[${edge.relation}]--> ${edge.to}`,
      status: 'canonical',
      canonical: true,
      workspaceId: normalizeWorkspaceId(edge.workspaceId),
      confidence: typeof edge.provenance.confidence === 'number' ? edge.provenance.confidence : edge.confidence ?? edge.weight ?? 0.5,
      provenance: provenanceShape(edge.provenance, edge.workspaceId),
      trustPolicyVersion: coerceString(edge.provenance?.trustPolicyVersion, ''),
      createdAt: edge.created_at || edge.updated_at || '',
    });
  }

  for (const candidate of candidates) {
    const normalized = publicCandidateClaim(candidate);
    if (!normalized || !normalized.provenance) continue;
    if (!matchesWorkspace(normalized.workspaceId, workspaceId, crossWorkspace)) continue;
    if (!matchesProvenanceFilters(normalized.provenance, filters)) continue;
    const candidateTargetIds = [
      normalized.candidateId,
      normalized.proposedEdge?.from,
      normalized.proposedEdge?.to,
      normalized.proposedEdge ? `${normalized.proposedEdge.from}|${normalized.proposedEdge.relation}|${normalized.proposedEdge.to}` : '',
    ].filter(Boolean);
    if (targetId && !candidateTargetIds.includes(targetId)) continue;
    records.push({
      kind: 'candidate_claim',
      targetType: 'candidate_claim',
      targetId: normalized.candidateId,
      claim: normalized.claim,
      status: normalized.status,
      canonical: normalized.status === 'accepted',
      workspaceId: normalized.workspaceId,
      confidence: typeof normalized.provenance.confidence === 'number' ? normalized.provenance.confidence : normalized.proposedEdge?.confidence ?? 0.5,
      provenance: normalized.provenance,
      trustPolicyVersion: normalized.provenance?.trustPolicyVersion || '',
      createdAt: normalized.createdAt,
      recommendation: normalized.recommendation,
      conflict: safeJsonClone(normalized.conflict, null),
      candidateClaim: normalized,
    });
  }

  records.sort((a, b) => recordSort(a, b, filters.order || 'asc'));
  return records;
}

function queryAuditTrail(target, filters = {}) {
  const graph = getGraph(target);
  if (!graph || typeof graph.getAuditEvents !== 'function') return [];
  const workspaceId = normalizeWorkspaceId(filters.workspaceId);
  const crossWorkspace = filters.crossWorkspace === true;
  const order = filters.order === 'desc' ? 'desc' : 'asc';
  const baseFilters = {
    workspaceId: crossWorkspace ? undefined : workspaceId,
    eventType: filters.eventType,
    targetId: filters.targetId,
    provenanceId: filters.provenanceId,
    sourceRef: filters.sourceRef,
    actor: filters.actor,
  };
  const events = graph.getAuditEvents(baseFilters)
    .map(publicAuditEvent)
    .filter(Boolean)
    .filter((event) => matchesWorkspace(event.workspaceId, workspaceId, crossWorkspace));
  events.sort((a, b) => recordSort(a, b, order));
  return events;
}

function queryCandidateClaims(target, filters = {}) {
  const graph = getGraph(target);
  if (!graph || typeof graph.getCandidateClaims !== 'function') return [];
  const workspaceId = normalizeWorkspaceId(filters.workspaceId);
  const crossWorkspace = filters.crossWorkspace === true;
  const order = filters.order === 'desc' ? 'desc' : 'asc';
  const source = crossWorkspace
    ? (graph._candidateClaims || [])
    : graph.getCandidateClaims({ workspaceId });
  const items = source
    .map(publicCandidateClaim)
    .filter(Boolean)
    .filter((candidate) => matchesWorkspace(candidate.workspaceId, workspaceId, crossWorkspace))
    .filter((candidate) => {
      const targetMatch = !filters.targetId
        || candidate.candidateId === filters.targetId
        || candidate.proposedEdge?.from === filters.targetId
        || candidate.proposedEdge?.to === filters.targetId
        || `${candidate.proposedEdge?.from || ''}|${candidate.proposedEdge?.relation || ''}|${candidate.proposedEdge?.to || ''}` === filters.targetId;
      if (!targetMatch) return false;
      if (filters.candidateId && candidate.candidateId !== filters.candidateId) return false;
      if (filters.status && candidate.status !== filters.status) return false;
      if (filters.recommendation && candidate.recommendation !== filters.recommendation) return false;
      if (filters.sourceRef && candidate.provenance?.sourceRef !== filters.sourceRef) return false;
      if (filters.provenanceId && candidate.provenance?.provenanceId !== filters.provenanceId) return false;
      return true;
    });
  items.sort((a, b) => recordSort(a, b, order));
  return items;
}

function findCanonicalRecord(target, filters, provenanceRecords, candidateClaims) {
  const graph = getGraph(target);
  if (!graph) return null;
  const workspaceId = normalizeWorkspaceId(filters.workspaceId);
  const targetId = coerceString(filters.targetId, '');

  if (targetId) {
    if (typeof graph.getNode === 'function') {
      const node = graph.getNode(targetId, workspaceId);
      if (node) {
        return {
          kind: 'node',
          targetType: 'node',
          targetId: node.id,
          claim: node.label || node.id,
          status: 'canonical',
          canonical: true,
          workspaceId: normalizeWorkspaceId(node.workspaceId),
          confidence: typeof node.provenance?.confidence === 'number' ? node.provenance.confidence : node.weight ?? 0.5,
          provenance: provenanceShape(node.provenance, node.workspaceId),
          trustPolicyVersion: coerceString(node.provenance?.trustPolicyVersion, ''),
          createdAt: node.created_at || node.last_seen || '',
        };
      }
    }
    if (Array.isArray(graph._edges)) {
      const edge = graph._edges.find((item) => {
        const compositeId = `${item.from}|${item.relation}|${item.to}`;
        return normalizeWorkspaceId(item.workspaceId) === workspaceId && (
          item.from === targetId ||
          item.to === targetId ||
          compositeId === targetId
        );
      });
      if (edge) {
        return {
          kind: 'edge',
          targetType: 'edge',
          targetId: `${edge.from}|${edge.relation}|${edge.to}`,
          claim: `${edge.from} --[${edge.relation}]--> ${edge.to}`,
          status: 'canonical',
          canonical: true,
          workspaceId: normalizeWorkspaceId(edge.workspaceId),
          confidence: typeof edge.provenance?.confidence === 'number' ? edge.provenance.confidence : edge.confidence ?? edge.weight ?? 0.5,
          provenance: provenanceShape(edge.provenance, edge.workspaceId),
          trustPolicyVersion: coerceString(edge.provenance?.trustPolicyVersion, ''),
          createdAt: edge.created_at || edge.updated_at || '',
        };
      }
    }
  }

  if (provenanceRecords.length > 0) {
    const first = provenanceRecords[0];
    return {
      ...first,
      canonical: first.status === 'canonical',
    };
  }

  return null;
}

function deriveTrustStatus(canonicalRecord, candidateClaims = [], provenanceRecords = []) {
  const shadowingCandidates = canonicalRecord
    ? candidateClaims.filter((candidate) => matchesCanonicalTarget(candidate, canonicalRecord))
    : candidateClaims;
  if (shadowingCandidates.some((candidate) => candidate.status === 'rejected' || candidate.recommendation === 'reject')) {
    return 'rejected';
  }
  if (shadowingCandidates.some((candidate) => candidate.status === 'flagged' || candidate.recommendation === 'flag')) {
    return 'flagged';
  }
  if (shadowingCandidates.some((candidate) => candidate.status === 'pending')) {
    return 'pending';
  }
  if (canonicalRecord) {
    return 'canonical';
  }
  if (candidateClaims.some((candidate) => candidate.status === 'rejected' || candidate.recommendation === 'reject')) {
    return 'rejected';
  }
  if (candidateClaims.some((candidate) => candidate.status === 'flagged' || candidate.recommendation === 'flag')) {
    return 'flagged';
  }
  if (candidateClaims.some((candidate) => candidate.status === 'pending')) {
    return 'pending';
  }
  if (candidateClaims.length > 0) {
    return 'pending';
  }
  if (provenanceRecords.length > 0) {
    return 'pending';
  }
  return 'unknown';
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
    confidence: canonicalReceipt
      ? canonical?.confidence ?? provenance[0]?.confidence ?? 0.5
      : selectedCandidate?.provenance?.confidence ?? provenance[0]?.confidence ?? 0.5,
    auditTrail,
    conflict: conflict?.conflict || null,
    candidateClaim: selectedCandidate || null,
    canonical: canonicalReceipt,
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
  normalizeTrustReceipt,
  queryAuditTrail,
  queryCandidateClaims,
  queryProvenance,
  queryTrustGraph,
};
