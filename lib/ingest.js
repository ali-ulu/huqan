// Ingest entry point: handleIngest builds the capability payload and hands it
// to the kernel runtime. Snapshots, source references and approval binding
// live in ingest-*.js (#2171).

const { CANONICAL_INGEST_WORKSPACE_ID, buildIngestApprovalSnapshot, resolveCanonicalIngestWorkspace, verifyIngestApprovalSnapshot } = require('./ingest-approval');
const { buildCapabilityPayload, buildIdempotencyKey, buildSourceRef, safeCanonicalizeGitHubRepoUrl } = require('./ingest-capability');
const { buildImmutableExternalSourceSnapshot, externalSnapshotManifestView } = require('./ingest-snapshot-build');
const { verifyImmutableExternalSourceSnapshot } = require('./ingest-snapshot-verify');
const { EXTERNAL_SOURCE_SNAPSHOT_VERSION, MAX_EXTERNAL_SNAPSHOT_BYTES, MAX_EXTERNAL_SNAPSHOT_FILES, normalizeGitHubCommitSha, normalizeSnapshotPath, normalizeSourceType, sanitizeString, sha256, sha256Text, stableStringify } = require('./ingest-values');

async function handleIngest({ kernel, data, ensureRuntime }) {
  if (!kernel || typeof kernel.runCapability !== 'function') {
    return { ok: false, error: 'kernel.runCapability gerekli' };
  }

  if (typeof ensureRuntime === 'function') {
    ensureRuntime();
  }

  const sourceType = normalizeSourceType(data && (data.sourceType || data.source || ''));
  const normalizedType = sourceType || '';
  const allowed = new Set(['github', 'markdown', 'manual', 'decision']);
  if (!allowed.has(normalizedType)) {
    return { ok: false, error: 'sourceType must be one of github|markdown|manual|decision' };
  }

  if (normalizedType === 'github') {
    const repoValidation = safeCanonicalizeGitHubRepoUrl(data || {});
    if (!repoValidation.ok) return repoValidation;
  }

  const sourceRef = buildSourceRef(data || {}, normalizedType);
  const idempotencyKey = buildIdempotencyKey(data || {}, normalizedType, sourceRef);
  const payload = buildCapabilityPayload(data || {}, normalizedType, sourceRef, idempotencyKey);
  if (!payload) {
    return { ok: false, error: 'sourceType must be one of github|markdown|manual|decision' };
  }

  const capability = normalizedType === 'github' || normalizedType === 'markdown'
    ? 'repoMemory'
    : 'companyBrain';

  const result = await kernel.runCapability(capability, payload);
  if (result && typeof result === 'object') {
    return {
      ...result,
      ingestMeta: {
        sourceType: normalizedType,
        sourceRef,
        idempotencyKey,
      },
    };
  }
  return result;
}

module.exports = {
  CANONICAL_INGEST_WORKSPACE_ID,
  resolveCanonicalIngestWorkspace,
  verifyIngestApprovalSnapshot,
  EXTERNAL_SOURCE_SNAPSHOT_VERSION,
  MAX_EXTERNAL_SNAPSHOT_FILES,
  MAX_EXTERNAL_SNAPSHOT_BYTES,
  sanitizeString,
  normalizeSourceType,
  normalizeGitHubCommitSha,
  normalizeSnapshotPath,
  buildImmutableExternalSourceSnapshot,
  verifyImmutableExternalSourceSnapshot,
  externalSnapshotManifestView,
  buildIdempotencyKey,
  buildSourceRef,
  buildCapabilityPayload,
  buildIngestApprovalSnapshot,
  stableStringify,
  sha256,
  sha256Text,
  handleIngest,
};
