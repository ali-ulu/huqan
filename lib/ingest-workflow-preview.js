'use strict';

const { buildIngestApprovalSnapshot } = require('./ingest');

const SOURCE_MANIFEST_VERSION = 'huqan.ingest-source-manifest.v1';

// Preview is deliberately a projection of the existing HTTP approval snapshot.
// It owns no connector, queue or mutation path and therefore cannot resurrect
// the retired reviewed-external subsystem (#702).
function buildIngestWorkflowPreview(input = {}) {
  const snapshot = buildIngestApprovalSnapshot(input);
  if (!snapshot.ok) return snapshot;

  return {
    ok: true,
    workflowId: 'ingest-preview',
    status: 'completed',
    sourceManifest: {
      version: SOURCE_MANIFEST_VERSION,
      workspaceId: snapshot.workspaceId,
      sourceType: snapshot.sourceType,
      sourceRef: snapshot.sourceRef,
      sourceDigest: snapshot.snapshotHash,
      idempotencyKey: snapshot.idempotencyKey,
      itemCount: 1,
    },
    review: {
      required: true,
      canonicalWrite: false,
      nextAction: 'submit_ingest_execute',
      executeRoute: '/api/ingest',
    },
    progress: {
      completed: 0,
      total: 1,
      hasMore: false,
    },
  };
}

module.exports = { SOURCE_MANIFEST_VERSION, buildIngestWorkflowPreview };
