'use strict';

const { resolveGitHubSourceSnapshot, resolveMarkdownSourceSnapshot } = require('./external-source-resolver');
const {
  buildImmutableExternalSourceSnapshot,
  normalizeSnapshotPath,
  normalizeSourceType,
  sha256,
  sha256Text,
  stableStringify,
  verifyImmutableExternalSourceSnapshot,
} = require('./ingest');

const EXTERNAL_INGEST_APPROVAL_VERSION = 'huqan.external-ingest-approval.v1';
const REVIEWED_SOURCE_VERSION = 'huqan.reviewed-external-source.v1';
const FILE_FIELDS = new Set(['path', 'content', 'contentHash', 'sizeBytes', 'blobSha']);
const SOURCE_FIELDS = Object.freeze({
  github: new Set(['version', 'sourceType', 'sourceRef', 'immutableSourceId', 'repoUrl', 'commitSha', 'files', 'reviewedManifestHash']),
  markdown: new Set(['version', 'sourceType', 'sourceRef', 'immutableSourceId', 'path', 'files', 'reviewedManifestHash']),
});
const APPROVAL_FIELDS = new Set([
  'version', 'sourceType', 'sourceRef', 'immutableSourceId', 'reviewedManifestHash',
  'requester', 'workspaceId', 'requestedAt', 'expiresAt', 'idempotencyKey',
  'requestIdentityHash', 'approvalKey', 'snapshotHash', 'payload',
]);
const PAYLOAD_FIELDS = new Set([
  'action', 'version', 'sourceType', 'sourceRef', 'immutableSourceId', 'reviewedManifestHash',
  'requester', 'workspaceId', 'requestedAt', 'expiresAt', 'idempotencyKey', 'reviewedSource',
]);

function fail(code, error) {
  return { ok: false, code, error };
}

function exactFields(value, allowed) {
  return Object.keys(value).every(key => allowed.has(key));
}

function boundedIdentity(value, name, code) {
  const text = String(value == null ? '' : value).trim();
  if (!text || text.length > 128 || /[\u0000-\u001f\u007f]/u.test(text)) {
    return fail(`EXTERNAL_APPROVAL_${code}_REQUIRED`, `${name} is required and must be a bounded printable string`);
  }
  return { ok: true, value: text };
}

function canonicalTime(value, name, code) {
  const text = String(value == null ? '' : value).trim();
  const millis = Date.parse(text);
  if (!text || !Number.isFinite(millis) || new Date(millis).toISOString() !== text) {
    return fail(`EXTERNAL_APPROVAL_${code}_INVALID`, `${name} must be a canonical ISO-8601 timestamp`);
  }
  return { ok: true, value: text, millis };
}

function requestMetadata(data = {}) {
  const requester = boundedIdentity(data.requester || data.actor, 'requester', 'REQUESTER');
  if (!requester.ok) return requester;
  const workspaceId = boundedIdentity(data.workspaceId, 'workspaceId', 'WORKSPACE_ID');
  if (!workspaceId.ok) return workspaceId;
  const idempotencyKey = String(data.idempotencyKey || data.idempotency_key || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(idempotencyKey)) {
    return fail('EXTERNAL_APPROVAL_IDEMPOTENCY_KEY_REQUIRED', 'an explicit bounded idempotencyKey is required');
  }
  const requestedAt = canonicalTime(data.requestedAt, 'requestedAt', 'REQUESTED_AT');
  if (!requestedAt.ok) return requestedAt;
  const expiresAt = canonicalTime(data.expiresAt, 'expiresAt', 'EXPIRES_AT');
  if (!expiresAt.ok) return expiresAt;
  if (expiresAt.millis <= requestedAt.millis) {
    return fail('EXTERNAL_APPROVAL_WINDOW_INVALID', 'expiresAt must be later than requestedAt');
  }
  return {
    ok: true,
    requester: requester.value,
    workspaceId: workspaceId.value,
    idempotencyKey,
    requestedAt: requestedAt.value,
    expiresAt: expiresAt.value,
  };
}

function reviewedManifestView(source) {
  const view = {
    version: source.version,
    sourceType: source.sourceType,
    sourceRef: source.sourceRef,
    immutableSourceId: source.immutableSourceId,
    files: source.files.map(file => ({
      path: file.path,
      contentHash: file.contentHash,
      sizeBytes: file.sizeBytes,
      ...(file.blobSha ? { blobSha: file.blobSha } : {}),
    })),
  };
  if (source.sourceType === 'github') Object.assign(view, { repoUrl: source.repoUrl, commitSha: source.commitSha });
  else view.path = source.path;
  return view;
}

function toReviewedSource(snapshot) {
  const source = {
    version: REVIEWED_SOURCE_VERSION,
    sourceType: snapshot.sourceType,
    sourceRef: snapshot.sourceRef,
    immutableSourceId: snapshot.immutableSourceId,
    files: snapshot.files.map(file => ({ ...file })),
  };
  if (snapshot.sourceType === 'github') Object.assign(source, { repoUrl: snapshot.repoUrl, commitSha: snapshot.commitSha });
  else source.path = snapshot.path; // rootPath is intentionally never persisted.
  return { ...source, reviewedManifestHash: sha256(reviewedManifestView(source)) };
}

function reviewedSourceFromResolution(resolution = {}) {
  if (!resolution || resolution.ok !== true || !resolution.snapshot) {
    return fail(resolution?.code || 'EXTERNAL_SOURCE_RESOLUTION_REQUIRED', resolution?.error || 'trusted source resolution is required');
  }
  const verified = verifyImmutableExternalSourceSnapshot(resolution.snapshot);
  if (!verified.ok) return verified;
  if (verified.sourceType === 'github' && verified.snapshot.files.some(file => !file.blobSha)) {
    return fail('GITHUB_BLOB_IDENTITY_REQUIRED', 'trusted GitHub reviewed files require verified blob SHAs');
  }
  return { ok: true, reviewedSource: toReviewedSource(verified.snapshot) };
}

function verifyReviewedSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return fail('REVIEWED_SOURCE_INVALID', 'reviewed source must be an object');
  if (source.version !== REVIEWED_SOURCE_VERSION) return fail('REVIEWED_SOURCE_VERSION_UNSUPPORTED', 'reviewed source version is unsupported');
  const allowed = SOURCE_FIELDS[source.sourceType];
  if (!allowed || !exactFields(source, allowed)) return fail('REVIEWED_SOURCE_FIELD_UNSUPPORTED', 'reviewed source contains unsupported fields');
  if (!Array.isArray(source.files) || source.files.length === 0) return fail('REVIEWED_SOURCE_FILES_REQUIRED', 'reviewed source files are required');
  if (source.sourceType === 'github' && source.files.some(file => !file?.blobSha)) {
    return fail('GITHUB_BLOB_IDENTITY_REQUIRED', 'reviewed GitHub files require blob SHAs');
  }
  for (const file of source.files) {
    if (!file || typeof file !== 'object' || Array.isArray(file) || !exactFields(file, FILE_FIELDS)) {
      return fail('REVIEWED_SOURCE_FIELD_UNSUPPORTED', 'reviewed source file contains unsupported fields');
    }
    if (!normalizeSnapshotPath(file.path) || typeof file.content !== 'string') return fail('REVIEWED_SOURCE_FILE_INVALID', 'reviewed source file is invalid');
    if (file.contentHash !== sha256Text(file.content) || file.sizeBytes !== Buffer.byteLength(file.content, 'utf8')) {
      return fail('REVIEWED_SOURCE_CONTENT_MISMATCH', `reviewed source content mismatch: ${file.path}`);
    }
  }
  const rebuilt = source.sourceType === 'github'
    ? buildImmutableExternalSourceSnapshot({ sourceType: 'github', repoUrl: source.repoUrl, commitSha: source.commitSha, files: source.files })
    : buildImmutableExternalSourceSnapshot({ sourceType: 'markdown', rootPath: '[redacted]', path: source.path, files: source.files });
  if (!rebuilt.ok) return rebuilt;
  const expected = toReviewedSource(rebuilt.snapshot);
  return stableStringify(source) === stableStringify(expected)
    ? { ok: true, reviewedSource: expected }
    : fail('REVIEWED_SOURCE_INTEGRITY_MISMATCH', 'reviewed source no longer matches its immutable content binding');
}

function requestIdentityHash({ workspaceId, requester, idempotencyKey }) {
  return sha256({ version: EXTERNAL_INGEST_APPROVAL_VERSION, workspaceId, requester, idempotencyKey });
}

function buildFromResolution(data = {}, resolution = {}) {
  const sourceType = normalizeSourceType(data.sourceType || data.source);
  if (!['github', 'markdown'].includes(sourceType)) return fail('EXTERNAL_APPROVAL_SOURCE_TYPE_UNSUPPORTED', 'external approval supports github or markdown only');
  const metadata = requestMetadata(data);
  if (!metadata.ok) return metadata;
  const reviewed = reviewedSourceFromResolution(resolution);
  if (!reviewed.ok) return reviewed;
  if (reviewed.reviewedSource.sourceType !== sourceType) return fail('EXTERNAL_APPROVAL_SOURCE_TYPE_MISMATCH', 'resolved sourceType does not match request');

  const source = reviewed.reviewedSource;
  const { ok: _metadataOk, ...meta } = metadata;
  const identityHash = requestIdentityHash(meta);
  const approvalKey = `http.ingest.external.${identityHash.slice('sha256:'.length)}`;
  const payload = {
    action: 'ingest_reviewed_external_snapshot',
    version: EXTERNAL_INGEST_APPROVAL_VERSION,
    sourceType,
    sourceRef: source.sourceRef,
    immutableSourceId: source.immutableSourceId,
    reviewedManifestHash: source.reviewedManifestHash,
    ...meta,
    reviewedSource: source,
  };
  return {
    ok: true,
    approval: {
      version: EXTERNAL_INGEST_APPROVAL_VERSION,
      sourceType,
      sourceRef: source.sourceRef,
      immutableSourceId: source.immutableSourceId,
      reviewedManifestHash: source.reviewedManifestHash,
      ...meta,
      requestIdentityHash: identityHash,
      approvalKey,
      snapshotHash: sha256(payload),
      payload,
    },
  };
}

async function resolveExternalIngestApproval(data = {}, options = {}) {
  const sourceType = normalizeSourceType(data.sourceType || data.source);
  if (!['github', 'markdown'].includes(sourceType)) return fail('EXTERNAL_APPROVAL_SOURCE_TYPE_UNSUPPORTED', 'external approval supports github or markdown only');
  const metadata = requestMetadata(data);
  if (!metadata.ok) return metadata; // no source access before identity/window validation.
  const resolution = sourceType === 'github'
    ? await resolveGitHubSourceSnapshot(data, options)
    : resolveMarkdownSourceSnapshot(data);
  return buildFromResolution({ ...data, sourceType }, resolution);
}

function verifyExternalIngestApproval(approval, options = {}) {
  if (!approval || typeof approval !== 'object' || Array.isArray(approval)) return fail('EXTERNAL_APPROVAL_INVALID', 'external approval must be an object');
  if (!exactFields(approval, APPROVAL_FIELDS)) return fail('EXTERNAL_APPROVAL_FIELD_UNSUPPORTED', 'external approval contains unsupported fields');
  if (approval.version !== EXTERNAL_INGEST_APPROVAL_VERSION) return fail('EXTERNAL_APPROVAL_VERSION_UNSUPPORTED', 'external approval version is unsupported');
  if (!approval.payload || typeof approval.payload !== 'object' || Array.isArray(approval.payload) || !exactFields(approval.payload, PAYLOAD_FIELDS)) {
    return fail('EXTERNAL_APPROVAL_FIELD_UNSUPPORTED', 'external approval payload is invalid');
  }
  const metadata = requestMetadata(approval);
  if (!metadata.ok) return metadata;
  const reviewed = verifyReviewedSource(approval.payload.reviewedSource);
  if (!reviewed.ok) return reviewed;

  const source = reviewed.reviewedSource;
  const { ok: _metadataOk, ...meta } = metadata;
  const identityHash = requestIdentityHash(meta);
  const approvalKey = `http.ingest.external.${identityHash.slice('sha256:'.length)}`;
  const expectedPayload = {
    action: 'ingest_reviewed_external_snapshot',
    version: EXTERNAL_INGEST_APPROVAL_VERSION,
    sourceType: source.sourceType,
    sourceRef: source.sourceRef,
    immutableSourceId: source.immutableSourceId,
    reviewedManifestHash: source.reviewedManifestHash,
    ...meta,
    reviewedSource: source,
  };
  if (
    approval.sourceType !== source.sourceType
    || approval.sourceRef !== source.sourceRef
    || approval.immutableSourceId !== source.immutableSourceId
    || approval.reviewedManifestHash !== source.reviewedManifestHash
    || approval.requestIdentityHash !== identityHash
    || approval.approvalKey !== approvalKey
    || approval.snapshotHash !== sha256(expectedPayload)
    || stableStringify(approval.payload) !== stableStringify(expectedPayload)
  ) return fail('EXTERNAL_APPROVAL_INTEGRITY_MISMATCH', 'external approval no longer matches its reviewed source');

  const now = canonicalTime(options.now instanceof Date ? options.now.toISOString() : (options.now || new Date().toISOString()), 'now', 'NOW');
  if (!now.ok) return now;
  if (now.millis < Date.parse(meta.requestedAt)) return fail('EXTERNAL_APPROVAL_NOT_YET_VALID', 'external approval validity window has not started');
  if (now.millis >= Date.parse(meta.expiresAt)) return fail('EXTERNAL_APPROVAL_EXPIRED', 'external approval validity window has expired');
  if (options.expectedWorkspaceId && options.expectedWorkspaceId !== approval.workspaceId) return fail('EXTERNAL_APPROVAL_WORKSPACE_MISMATCH', 'workspace does not match execution context');
  if (options.expectedRequester && options.expectedRequester !== approval.requester) return fail('EXTERNAL_APPROVAL_REQUESTER_MISMATCH', 'requester does not match execution context');
  if (options.expectedApprovalKey && options.expectedApprovalKey !== approval.approvalKey) return fail('EXTERNAL_APPROVAL_KEY_MISMATCH', 'approval key does not match stored request identity');
  if (options.expectedSnapshotHash && options.expectedSnapshotHash !== approval.snapshotHash) return fail('EXTERNAL_APPROVAL_SNAPSHOT_HASH_MISMATCH', 'snapshot hash does not match stored reviewed payload');
  return { ok: true, approval: { ...approval, payload: expectedPayload } };
}

module.exports = {
  EXTERNAL_INGEST_APPROVAL_VERSION,
  REVIEWED_SOURCE_VERSION,
  resolveExternalIngestApproval,
  verifyExternalIngestApproval,
  verifyReviewedSource,
};
