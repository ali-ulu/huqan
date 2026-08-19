const {
  CAUSAL_RELATIONS,
  normalizeWorkspaceId,
  nowIso,
  deepClone,
  isPlainObject,
  cloneEdgeRecord,
  clamp01,
  sanitizeEdgeMeta,
} = require('./graph-record-utils');

function addEdge(storeApi, fromId, toId, relation, opts = {}) {
  const workspaceId = normalizeWorkspaceId(opts.workspaceId || opts.provenance?.workspaceId);
  if (!storeApi.hasNode(fromId, workspaceId) || !storeApi.hasNode(toId, workspaceId)) return null;
  storeApi.touchNode(fromId, workspaceId);
  storeApi.touchNode(toId, workspaceId);
  const hasExplicitProvenance = opts.provenance && typeof opts.provenance === 'object';
  const hasExplicitMeta = isPlainObject(opts.meta);
  const nextMeta = sanitizeEdgeMeta(opts.meta);

  const isCausal = CAUSAL_RELATIONS.includes(relation);
  if (isCausal) {
    if (opts.strength === undefined) {
      throw new Error(`Causal relation '${relation}' requires strength field (0-1)`);
    }
    if (typeof opts.strength !== 'number' || opts.strength < 0 || opts.strength > 1) {
      throw new Error(`Causal relation '${relation}' requires strength between 0 and 1`);
    }
  }

  const existing = storeApi.findExisting(fromId, toId, relation, workspaceId);
  const isoNow = nowIso();
  const requestedCreatedAt = typeof opts.createdAt === 'string' && opts.createdAt ? opts.createdAt : '';
  const nextEvidence = Array.isArray(opts.evidence) ? opts.evidence : [];
  if (existing) {
    const oldConfidence = existing.confidence ?? existing.weight ?? 0.5;
    const requestedWeight = opts.weight === undefined
      ? (existing.weight ?? 0.5) + 0.1
      : opts.weight;
    const nextWeight = clamp01(requestedWeight, existing.weight ?? 0.5);
    const requestedConfidence = opts.confidence === undefined
      ? (Number.isFinite(Number(existing.confidence)) ? existing.confidence : nextWeight)
      : opts.confidence;
    existing.weight = nextWeight;
    existing.confidence = clamp01(requestedConfidence, nextWeight);
    if (opts.source) existing.source = opts.source;
    if (typeof opts.sourceRef === 'string') existing.source_ref = opts.sourceRef;
    if (typeof opts.sessionId === 'string') existing.session_id = opts.sessionId;
    if (typeof opts.evidenceType === 'string') existing.evidence_type = opts.evidenceType;
    if (typeof opts.sourceType === 'string') existing.source_type = opts.sourceType;
    if (typeof opts.companyMode === 'boolean') existing.company_mode = opts.companyMode ? 1 : 0;
    if (hasExplicitProvenance) existing.provenance = deepClone(opts.provenance);
    if (hasExplicitMeta) existing.meta = nextMeta;
    else existing.meta = sanitizeEdgeMeta(existing.meta);
    existing.workspaceId = workspaceId;
    if (requestedCreatedAt && !existing.created_at) existing.created_at = requestedCreatedAt;
    existing.evidence = [...new Set([...(existing.evidence || []), ...nextEvidence])];
    existing.updated_at = isoNow;
    if (isCausal && opts.strength !== undefined) existing.strength = opts.strength;
    if (!Array.isArray(existing.confidence_history)) existing.confidence_history = [];
    if (existing.confidence !== oldConfidence) {
      existing.confidence_history.push({ value: oldConfidence, updated_at: isoNow });
    }
    storeApi.persistUpdate(existing, workspaceId, fromId, toId, relation, isoNow);
    storeApi.recordTouch(workspaceId, fromId, relation, toId);
    return cloneEdgeRecord(existing);
  }

  const edge = {
    from: fromId,
    to: toId,
    relation,
    weight: clamp01(opts.weight, 0.5),
    confidence: clamp01(opts.confidence, clamp01(opts.weight, 0.5)),
    source: opts.source || 'manual',
    source_ref: opts.sourceRef || '',
    session_id: opts.sessionId || '',
    evidence: nextEvidence,
    evidence_type: opts.evidenceType || '',
    confidence_history: [],
    company_mode: opts.companyMode ? 1 : 0,
    source_type: opts.sourceType || '',
    updated_at: isoNow,
    created_at: requestedCreatedAt || isoNow,
    provenance: hasExplicitProvenance ? deepClone(opts.provenance) : null,
    meta: nextMeta,
    created: Date.now(),
    workspaceId,
  };
  if (isCausal) edge.strength = opts.strength ?? 0.5;
  storeApi.append(edge);
  storeApi.persistCreate(edge, workspaceId, fromId, toId, relation, isoNow);
  storeApi.recordTouch(workspaceId, fromId, relation, toId);
  return cloneEdgeRecord(edge);
}

module.exports = { addEdge };
