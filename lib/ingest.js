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
    // Translate only when the capability produced an admission summary, so
    // results without one keep their exact key set (see the gate-boundary
    // contract test).
    const translated = capability === 'repoMemory' && result.admission !== undefined
      ? { admission: toCanonicalIngestAdmission(result.admission) }
      : {};
    return {
      ...result,
      ...translated,
      ingestMeta: {
        sourceType: normalizedType,
        sourceRef,
        idempotencyKey,
      },
    };
  }
  return result;
}

/**
 * #3032: the approval-execution path classifies outcomes with
 * `classifyActionOutcome`, which only recognizes the canonical
 * allow/review/reject vocabulary (see lib/company-brain-ingest.js
 * `summarizeProposals`). The repo-memory connectors summarize with the
 * admitted/skipped/rejected/candidate vocabulary instead, so an approved
 * repo ingest would end `INGEST_EXECUTION_UNKNOWN` despite writing exactly
 * what was approved. Translate at this seam -- the only caller is the
 * approval-execution path -- and leave the connector summary untouched for
 * its direct callers. Anything unrecognized stays unrecognized downstream
 * (fail-closed), never upgraded to `allow`.
 */
function toCanonicalIngestAdmission(admission) {
  if (!admission || typeof admission !== 'object' || Array.isArray(admission)) return admission;
  const entries = Array.isArray(admission.entries) ? admission.entries : [];
  const graphWrite = entries.some((entry) => entry && entry.graphWrite === true);
  const outcome = admission.outcome === 'admitted' || admission.outcome === 'skipped'
    ? 'allow'
    : admission.outcome === 'candidate'
      ? 'review'
      : admission.outcome === 'rejected'
        ? 'reject'
        : admission.outcome;
  return { ...admission, outcome, graphWrite };
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
  toCanonicalIngestAdmission,
};
