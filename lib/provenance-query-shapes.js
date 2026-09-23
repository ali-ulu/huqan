'use strict';

// Small shared helpers and pure shape-normalizers used by the provenance
// query surface. Split out of lib/provenance-query.js (#2162): coercion
// helpers, entity-resolution/provenance/candidate/audit shaping and trust
// receipt normalization moved here byte-identical. The record collectors and
// query builders stay in their own modules.

const { randomUUID } = require('crypto');
const { normalizeAuditEvent } = require('./audit-log');
const { normalizeCandidateClaim } = require('./conflict-detector');
const { normalizeWorkspaceId } = require('./workspace-id');

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

function normalizeEntityResolution(entityResolution) {
  if (!entityResolution || typeof entityResolution !== 'object') return null;

  const original = coerceString(
    entityResolution.original ?? entityResolution.originalLiteral ?? '',
    '',
  );
  const canonical = coerceString(
    entityResolution.canonical ?? entityResolution.canonicalId ?? '',
    '',
  );
  const domain = coerceString(entityResolution.domain, '');
  const reason = coerceString(entityResolution.reason, '');
  const matched = entityResolution.matched === true;
  const normalized = {
    original,
    canonical,
    domain,
    reason,
    matched,
  };

  if (Object.prototype.hasOwnProperty.call(entityResolution, 'originalLiteral') || original) {
    normalized.originalLiteral = original;
  }
  if (Object.prototype.hasOwnProperty.call(entityResolution, 'canonicalId') || canonical) {
    normalized.canonicalId = canonical;
  }
  if (Object.prototype.hasOwnProperty.call(entityResolution, 'ambiguous')) {
    normalized.ambiguous = Boolean(entityResolution.ambiguous);
  }
  if (Array.isArray(entityResolution.aliases)) {
    normalized.aliases = [...entityResolution.aliases];
  }
  if (Array.isArray(entityResolution.candidates)) {
    normalized.candidates = [...entityResolution.candidates];
  }
  if (typeof entityResolution.confidence === 'number') {
    normalized.confidence = entityResolution.confidence;
  }

  const hasMeaningfulData = Boolean(
    normalized.original
      || normalized.canonical
      || normalized.domain
      || normalized.reason
      || normalized.matched
      || normalized.originalLiteral
      || normalized.canonicalId
      || normalized.ambiguous
      || normalized.aliases
      || normalized.candidates,
  );

  return hasMeaningfulData ? normalized : null;
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
    ...(normalizeEntityResolution(receipt.entityResolution)
      ? { entityResolution: normalizeEntityResolution(receipt.entityResolution) }
      : {}),
    generatedAt: coerceString(receipt.generatedAt, nowIso()),
  };
}

module.exports = {
  TRUST_STATUSES,
  coerceString,
  getGraph,
  normalizeEntityResolution,
  normalizeTrustReceipt,
  nowIso,
  provenanceShape,
  publicAuditEvent,
  publicCandidateClaim,
  safeJsonClone,
};
