// #2171: the canonical ingest workspace and the approval snapshot an
// ingest decision is bound to.

const { buildCapabilityPayload, buildIdempotencyKey, buildSourceRef, safeCanonicalizeGitHubRepoUrl } = require('./ingest-capability');
const { normalizeGitHubCommitSha, normalizeSourceType, sha256 } = require('./ingest-values');

// V4-B2B: the shared API-key HTTP surface authenticates one key and owns no
// caller-to-workspace mapping, so it may bind exactly one workspace. An absent
// workspaceId means canonical `default`; a supplied value must be the exact
// string `default`. Values are never trimmed or coerced first — padded and
// non-string identities fail closed, matching the WB2 audit-source boundary.
const CANONICAL_INGEST_WORKSPACE_ID = 'default';

function resolveCanonicalIngestWorkspace(data = {}) {
  const supplied = data.workspaceId === undefined ? data.workspace_id : data.workspaceId;
  if (supplied === undefined || supplied === null) {
    return { ok: true, workspaceId: CANONICAL_INGEST_WORKSPACE_ID };
  }
  if (supplied === CANONICAL_INGEST_WORKSPACE_ID) {
    return { ok: true, workspaceId: CANONICAL_INGEST_WORKSPACE_ID };
  }
  return {
    ok: false,
    code: 'INGEST_WORKSPACE_UNSUPPORTED',
    error: 'this ingest surface binds the canonical default workspace only',
  };
}

// The hash binds the canonical workspace alongside the capability payload, so a
// later edit to the persisted snapshot's workspace cannot pass verification.
function ingestApprovalSnapshotBindingView(snapshot) {
  return {
    workspaceId: snapshot.workspaceId,
    sourceType: snapshot.sourceType,
    sourceRef: snapshot.sourceRef,
    idempotencyKey: snapshot.idempotencyKey,
    payload: snapshot.payload,
  };
}

function githubQueueGuard(data = {}) {
  // #3032: a branch is a moving target, so a branch-only github payload can
  // never bind review to execution. A full commit SHA names immutable content
  // (git objects are content-addressed), which is exactly the immutable source
  // binding INGEST-SNAPSHOT-0 demands -- so SHA-pinned github is queueable and
  // everything else stays refused.
  const canonical = safeCanonicalizeGitHubRepoUrl(data);
  if (!canonical.ok) {
    return { ok: false, code: 'INGEST_SNAPSHOT_REQUIRED', error: 'github ingest requires a canonical repository URL and a full commit SHA (INGEST-SNAPSHOT-0)' };
  }
  const commitSha = normalizeGitHubCommitSha(data.commitSha || data.sha || data.headSha || '');
  if (!commitSha) {
    return { ok: false, code: 'INGEST_SNAPSHOT_REQUIRED', error: 'github ingest requires a full 40-character commit SHA before approval queueing (INGEST-SNAPSHOT-0)' };
  }
  return { ok: true };
}

function buildIngestApprovalSnapshot(data = {}) {
  const sourceType = normalizeSourceType(data.sourceType || data.source || '');
  if (sourceType === 'github') {
    const guard = githubQueueGuard(data);
    if (!guard.ok) return guard;
  } else if (!['manual', 'decision'].includes(sourceType)) {
    return { ok: false, code: 'INGEST_SNAPSHOT_REQUIRED', error: 'github and markdown ingest require INGEST-SNAPSHOT-0 before approval queueing' };
  }
  const workspace = resolveCanonicalIngestWorkspace(data);
  if (!workspace.ok) return workspace;
  const sourceRef = buildSourceRef(data, sourceType);
  const idempotencyKey = buildIdempotencyKey(data, sourceType, sourceRef);
  const payload = buildCapabilityPayload(data, sourceType, sourceRef, idempotencyKey);
  if (!payload) return { ok: false, code: 'INVALID_INGEST', error: 'invalid ingest payload' };
  const bound = {
    workspaceId: workspace.workspaceId,
    sourceType,
    sourceRef,
    idempotencyKey,
    payload,
  };
  return {
    ok: true,
    ...bound,
    snapshotHash: sha256(ingestApprovalSnapshotBindingView(bound)),
  };
}

// Re-derives the binding hash from the persisted snapshot. Execution-time
// verification and queue-time construction therefore share one definition.
function verifyIngestApprovalSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return { ok: false, code: 'SNAPSHOT_INVALID', error: 'queued ingest snapshot is missing' };
  }
  if (snapshot.workspaceId !== CANONICAL_INGEST_WORKSPACE_ID) {
    return { ok: false, code: 'SNAPSHOT_WORKSPACE_UNSUPPORTED', error: 'queued ingest snapshot is not bound to the canonical workspace' };
  }
  if (!['manual', 'decision', 'github'].includes(snapshot.sourceType)) {
    return { ok: false, code: 'SNAPSHOT_KIND_UNSUPPORTED', error: 'queued ingest snapshot kind is not manual, decision or pinned github' };
  }
  if (!snapshot.payload || typeof snapshot.payload !== 'object' || Array.isArray(snapshot.payload)) {
    return { ok: false, code: 'SNAPSHOT_INVALID', error: 'queued ingest snapshot payload is missing' };
  }
  if (snapshot.sourceType === 'github') {
    // Re-derive the queue-time constraints from the persisted payload: a row
    // edited to drop the pin must not verify.
    const guard = githubQueueGuard({ ...snapshot.payload, sourceType: 'github' });
    if (!guard.ok) {
      return { ok: false, code: 'SNAPSHOT_KIND_UNSUPPORTED', error: 'queued github snapshot lost its pinned commit SHA' };
    }
  }
  if (sha256(ingestApprovalSnapshotBindingView(snapshot)) !== snapshot.snapshotHash) {
    return { ok: false, code: 'SNAPSHOT_INTEGRITY_MISMATCH', error: 'queued ingest snapshot no longer validates' };
  }
  return { ok: true, workspaceId: snapshot.workspaceId, sourceType: snapshot.sourceType };
}

module.exports = {
  CANONICAL_INGEST_WORKSPACE_ID,
  buildIngestApprovalSnapshot,
  ingestApprovalSnapshotBindingView,
  resolveCanonicalIngestWorkspace,
  verifyIngestApprovalSnapshot,
};
