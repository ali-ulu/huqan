const crypto = require('crypto');
const { canonicalizeGitHubRepoUrl } = require('./github-url');

const EXTERNAL_SOURCE_SNAPSHOT_VERSION = 'huqan.external-source-snapshot.v1';
const MAX_EXTERNAL_SNAPSHOT_FILES = 200;
const MAX_EXTERNAL_SNAPSHOT_BYTES = 2 * 1024 * 1024;

function sanitizeString(value, maxLen = 512) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}

function normalizeSourceType(sourceType) {
  const raw = sanitizeString(sourceType, 32).toLowerCase();
  if (raw === 'repo') return 'github';
  if (raw === 'manuel') return 'manual';
  if (raw === 'karar') return 'decision';
  return raw;
}

function hashText(text) {
  return crypto.createHash('sha1').update(String(text || ''), 'utf8').digest('hex').slice(0, 16);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(stableStringify(value), 'utf8').digest('hex')}`;
}

function sha256Text(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value == null ? '' : value), 'utf8').digest('hex')}`;
}

function normalizeGitHubCommitSha(value) {
  const commitSha = sanitizeString(value, 64).toLowerCase();
  return /^[0-9a-f]{40}$/.test(commitSha) ? commitSha : '';
}

function normalizeSnapshotPath(value) {
  const raw = sanitizeString(value, 1024).replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!raw || raw.startsWith('/') || /^[a-z]:\//i.test(raw)) return '';
  const parts = raw.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return '';
  return parts.join('/');
}

function snapshotFailure(code, error) {
  return { ok: false, code, error };
}

function normalizeExternalSnapshotFiles(inputFiles) {
  if (!Array.isArray(inputFiles) || inputFiles.length === 0) {
    return snapshotFailure('SOURCE_SNAPSHOT_FILES_REQUIRED', 'at least one source snapshot file is required');
  }
  if (inputFiles.length > MAX_EXTERNAL_SNAPSHOT_FILES) {
    return snapshotFailure('SOURCE_SNAPSHOT_FILE_LIMIT', `source snapshot may contain at most ${MAX_EXTERNAL_SNAPSHOT_FILES} files`);
  }

  const seen = new Set();
  const files = [];
  let totalBytes = 0;

  for (const input of inputFiles) {
    if (!input || typeof input !== 'object') {
      return snapshotFailure('SOURCE_SNAPSHOT_FILE_INVALID', 'source snapshot file must be an object');
    }
    const filePath = normalizeSnapshotPath(input.path || input.filePath || '');
    if (!filePath) {
      return snapshotFailure('SOURCE_SNAPSHOT_PATH_INVALID', 'source snapshot paths must be relative and traversal-free');
    }
    const dedupeKey = filePath.toLowerCase();
    if (seen.has(dedupeKey)) {
      return snapshotFailure('SOURCE_SNAPSHOT_PATH_DUPLICATE', `duplicate source snapshot path: ${filePath}`);
    }
    seen.add(dedupeKey);

    if (typeof input.content !== 'string') {
      return snapshotFailure('SOURCE_SNAPSHOT_CONTENT_REQUIRED', `source snapshot content is required for ${filePath}`);
    }
    const sizeBytes = Buffer.byteLength(input.content, 'utf8');
    totalBytes += sizeBytes;
    if (totalBytes > MAX_EXTERNAL_SNAPSHOT_BYTES) {
      return snapshotFailure('SOURCE_SNAPSHOT_SIZE_LIMIT', `source snapshot may contain at most ${MAX_EXTERNAL_SNAPSHOT_BYTES} bytes`);
    }

    const contentHash = sha256Text(input.content);
    const suppliedContentHash = sanitizeString(input.contentHash || '', 80).toLowerCase();
    if (suppliedContentHash && suppliedContentHash !== contentHash) {
      return snapshotFailure('SOURCE_SNAPSHOT_CONTENT_HASH_MISMATCH', `source snapshot content hash mismatch: ${filePath}`);
    }

    const suppliedBlobSha = sanitizeString(input.blobSha || input.blob_sha || '', 64);
    const blobSha = suppliedBlobSha ? normalizeGitHubCommitSha(suppliedBlobSha) : '';
    if (suppliedBlobSha && !blobSha) {
      return snapshotFailure('SOURCE_SNAPSHOT_BLOB_SHA_INVALID', `invalid GitHub blob SHA: ${filePath}`);
    }

    files.push({
      path: filePath,
      content: input.content,
      contentHash,
      sizeBytes,
      ...(blobSha ? { blobSha } : {}),
    });
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  return { ok: true, files, totalBytes };
}

function externalSnapshotManifestView(snapshot) {
  const view = {
    version: snapshot.version,
    sourceType: snapshot.sourceType,
    sourceRef: snapshot.sourceRef,
    immutableSourceId: snapshot.immutableSourceId,
    files: snapshot.files.map(file => ({
      path: file.path,
      contentHash: file.contentHash,
      sizeBytes: file.sizeBytes,
      ...(file.blobSha ? { blobSha: file.blobSha } : {}),
    })),
  };

  if (snapshot.sourceType === 'github') {
    view.repoUrl = snapshot.repoUrl;
    view.commitSha = snapshot.commitSha;
  } else if (snapshot.sourceType === 'markdown') {
    view.path = snapshot.path;
    view.rootPath = snapshot.rootPath;
  }
  return view;
}

function finalizeExternalSourceSnapshot(snapshot) {
  const manifestHash = sha256(externalSnapshotManifestView(snapshot));
  return {
    ok: true,
    snapshot: {
      ...snapshot,
      manifestHash,
    },
    manifestHash,
  };
}

function buildImmutableExternalSourceSnapshot(data = {}) {
  const sourceType = normalizeSourceType(data.sourceType || data.source || '');
  if (!['github', 'markdown'].includes(sourceType)) {
    return snapshotFailure('SOURCE_SNAPSHOT_TYPE_UNSUPPORTED', 'immutable source snapshots support github or markdown only');
  }

  if (sourceType === 'github') {
    let canonicalRepo;
    try {
      canonicalRepo = canonicalizeGitHubRepoUrl(data.repoUrl || data.url || '');
    } catch (_) {
      return snapshotFailure('SOURCE_SNAPSHOT_REPO_INVALID', 'a canonical GitHub repository URL is required');
    }
    const commitSha = normalizeGitHubCommitSha(data.commitSha || data.sha || data.oid || '');
    if (!commitSha) {
      return snapshotFailure('IMMUTABLE_SOURCE_ID_REQUIRED', 'GitHub source snapshots require a full 40-character commit SHA');
    }
    const normalizedFiles = normalizeExternalSnapshotFiles(data.files);
    if (!normalizedFiles.ok) return normalizedFiles;

    const sourceRef = `${canonicalRepo.repoUrl}@${commitSha}`;
    return finalizeExternalSourceSnapshot({
      version: EXTERNAL_SOURCE_SNAPSHOT_VERSION,
      sourceType,
      sourceRef,
      immutableSourceId: commitSha,
      repoUrl: canonicalRepo.repoUrl,
      commitSha,
      files: normalizedFiles.files,
    });
  }

  const targetPath = normalizeSnapshotPath(data.path || data.targetPath || '');
  const rootPath = sanitizeString(data.rootPath || data.workspaceRoot || data.allowedRoot || '', 1024);
  if (!targetPath) {
    return snapshotFailure('SOURCE_SNAPSHOT_PATH_INVALID', 'markdown snapshot path must be relative and traversal-free');
  }
  if (!rootPath) {
    return snapshotFailure('MARKDOWN_ROOT_REQUIRED', 'markdown snapshot rootPath is required');
  }

  const inputFiles = Array.isArray(data.files)
    ? data.files
    : [{ path: targetPath, content: typeof data.content === 'string' ? data.content : data.text }];
  const normalizedFiles = normalizeExternalSnapshotFiles(inputFiles);
  if (!normalizedFiles.ok) return normalizedFiles;

  const contentSetHash = sha256({
    files: normalizedFiles.files.map(file => ({
      path: file.path,
      contentHash: file.contentHash,
      sizeBytes: file.sizeBytes,
    })),
  });
  const sourceRef = `file:${targetPath}@${contentSetHash}`;
  return finalizeExternalSourceSnapshot({
    version: EXTERNAL_SOURCE_SNAPSHOT_VERSION,
    sourceType,
    sourceRef,
    immutableSourceId: contentSetHash,
    path: targetPath,
    rootPath,
    files: normalizedFiles.files,
  });
}

function verifyImmutableExternalSourceSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return snapshotFailure('SOURCE_SNAPSHOT_INVALID', 'source snapshot must be an object');
  }
  if (snapshot.version !== EXTERNAL_SOURCE_SNAPSHOT_VERSION) {
    return snapshotFailure('SOURCE_SNAPSHOT_VERSION_UNSUPPORTED', 'source snapshot version is unsupported');
  }

  const rebuilt = buildImmutableExternalSourceSnapshot(snapshot);
  if (!rebuilt.ok) return rebuilt;
  const expected = rebuilt.snapshot;
  if (
    snapshot.sourceRef !== expected.sourceRef
    || snapshot.immutableSourceId !== expected.immutableSourceId
    || snapshot.manifestHash !== expected.manifestHash
  ) {
    return snapshotFailure('SOURCE_SNAPSHOT_INTEGRITY_MISMATCH', 'source snapshot manifest no longer matches its immutable binding');
  }

  return {
    ok: true,
    sourceType: expected.sourceType,
    sourceRef: expected.sourceRef,
    immutableSourceId: expected.immutableSourceId,
    manifestHash: expected.manifestHash,
    files: expected.files.length,
  };
}

function buildIdempotencyKey(data, sourceType, sourceRef) {
  const provided = sanitizeString(data.idempotencyKey || data.idempotency_key || '', 128);
  if (provided) return provided;
  const base = `${sourceType}:${sourceRef || hashText(JSON.stringify(data || {}))}`;
  return hashText(base);
}

function buildSourceRef(data, sourceType) {
  if (sourceType === 'github') {
    const repoUrl = canonicalizeGitHubRepoUrl(data.repoUrl || data.url || '').repoUrl;
    const branch = sanitizeString(data.branch || '', 128) || 'main';
    const paths = Array.isArray(data.paths) ? data.paths.map(item => sanitizeString(item, 512)).filter(Boolean).slice(0, 200) : [];
    return [repoUrl, branch, ...paths].filter(Boolean).join('#');
  }
  if (sourceType === 'markdown') {
    return sanitizeString(data.path || data.targetPath || '', 512);
  }
  if (sourceType === 'manual') {
    return sanitizeString(data.title || data.text || data.content || '', 512);
  }
  if (sourceType === 'decision') {
    return sanitizeString(data.title || data.baslik || '', 512);
  }
  return sanitizeString(data.sourceRef || data.sourceRefKey || '', 512);
}

function buildCapabilityPayload(data, sourceType, sourceRef, idempotencyKey) {
  const base = {
    action: 'ingest',
    sourceType,
    sourceRef,
    idempotencyKey,
  };

  if (sourceType === 'github') {
    return {
      ...base,
      repoUrl: canonicalizeGitHubRepoUrl(data.repoUrl || data.url || '').repoUrl,
      branch: sanitizeString(data.branch || '', 128) || 'main',
      paths: Array.isArray(data.paths) ? data.paths.slice(0, 200).map(item => sanitizeString(item, 512)).filter(Boolean) : undefined,
    };
  }

  if (sourceType === 'markdown') {
    return {
      ...base,
      path: sanitizeString(data.path || data.targetPath || '', 512),
      rootPath: sanitizeString(data.rootPath || data.workspaceRoot || data.allowedRoot || '', 512),
    };
  }

  if (sourceType === 'manual') {
    return {
      ...base,
      text: sanitizeString(data.text || '', 4000),
      author: sanitizeString(data.author || data.yazar || 'unknown', 128),
      date: sanitizeString(data.date || '', 32),
    };
  }

  if (sourceType === 'decision') {
    return {
      ...base,
      title: sanitizeString(data.title || data.baslik || '', 512),
      rationale: sanitizeString(data.rationale || data.gerekce || '', 4000),
      decidedBy: sanitizeString(data.decidedBy || data.author || data.yazar || 'unknown', 128),
      date: sanitizeString(data.date || '', 32),
      alternatives: Array.isArray(data.alternatives) ? data.alternatives.slice(0, 20).map(item => sanitizeString(item, 512)).filter(Boolean) : [],
      links: Array.isArray(data.links) ? data.links.slice(0, 50).map(item => sanitizeString(item, 512)).filter(Boolean) : [],
    };
  }

  return null;
}

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

function buildIngestApprovalSnapshot(data = {}) {
  const sourceType = normalizeSourceType(data.sourceType || data.source || '');
  if (!['manual', 'decision'].includes(sourceType)) {
    return { ok: false, code: 'INGEST_SNAPSHOT_REQUIRED', error: 'github and markdown ingest require INGEST-SNAPSHOT-0 before approval queueing' };
  }
  const sourceRef = buildSourceRef(data, sourceType);
  const idempotencyKey = buildIdempotencyKey(data, sourceType, sourceRef);
  const payload = buildCapabilityPayload(data, sourceType, sourceRef, idempotencyKey);
  if (!payload) return { ok: false, code: 'INVALID_INGEST', error: 'invalid ingest payload' };
  const snapshotHash = sha256(payload);
  return {
    ok: true,
    sourceType,
    sourceRef,
    idempotencyKey,
    snapshotHash,
    payload,
  };
}

module.exports = {
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
