'use strict';

const {
  buildIdempotencyKey,
  normalizeSourceType,
  sha256,
  verifyImmutableExternalSourceSnapshot,
} = require('./ingest');

function approvalFailure(code, error) {
  return { ok: false, code, error };
}

function selectExternalSourceSnapshot(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return data.externalSourceSnapshot || data.sourceSnapshot || data.snapshot || null;
}

function buildExternalIngestApprovalEnvelope(data = {}) {
  const suppliedSnapshot = selectExternalSourceSnapshot(data);
  if (!suppliedSnapshot) {
    return approvalFailure(
      'INGEST_SNAPSHOT_REQUIRED',
      'github and markdown approval queueing require a verified immutable source snapshot',
    );
  }

  const verified = verifyImmutableExternalSourceSnapshot(suppliedSnapshot);
  if (!verified.ok) return verified;

  const requestedType = normalizeSourceType(data.sourceType || data.source || '');
  if (requestedType && requestedType !== verified.sourceType) {
    return approvalFailure(
      'SOURCE_SNAPSHOT_TYPE_MISMATCH',
      'approval request sourceType does not match the immutable source snapshot',
    );
  }

  const idempotencyKey = buildIdempotencyKey(data, verified.sourceType, verified.sourceRef);
  const payload = {
    action: 'ingest',
    sourceType: verified.sourceType,
    sourceRef: verified.sourceRef,
    immutableSourceId: verified.immutableSourceId,
    manifestHash: verified.manifestHash,
    idempotencyKey,
    externalSourceSnapshot: verified.snapshot,
  };
  const snapshotHash = sha256(payload);

  return {
    ok: true,
    sourceType: verified.sourceType,
    sourceRef: verified.sourceRef,
    immutableSourceId: verified.immutableSourceId,
    manifestHash: verified.manifestHash,
    idempotencyKey,
    snapshotHash,
    payload,
  };
}

module.exports = {
  buildExternalIngestApprovalEnvelope,
};
