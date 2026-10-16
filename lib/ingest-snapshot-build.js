// #2171: building an immutable external-source snapshot -- bounded,
// normalized, sorted files and the manifest its hash covers.

const { canonicalizeGitHubRepoUrl } = require('./github-url');
const { EXTERNAL_SOURCE_SNAPSHOT_VERSION, MAX_EXTERNAL_SNAPSHOT_BYTES, MAX_EXTERNAL_SNAPSHOT_FILES, compareSnapshotPaths, normalizeGitHubCommitSha, normalizeSnapshotPath, normalizeSourceType, sha256, sha256Text, snapshotFailure, strictString } = require('./ingest-values');

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
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return snapshotFailure('SOURCE_SNAPSHOT_FILE_INVALID', 'source snapshot file must be an object');
    }
    const filePath = normalizeSnapshotPath(input.path || input.filePath || '');
    if (!filePath) {
      return snapshotFailure('SOURCE_SNAPSHOT_PATH_INVALID', 'source snapshot paths must be relative, canonical, and traversal-free');
    }
    const dedupeKey = filePath.normalize('NFC').toLowerCase();
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
    const suppliedContentHash = String(input.contentHash || '').trim().toLowerCase();
    if (suppliedContentHash && suppliedContentHash !== contentHash) {
      return snapshotFailure('SOURCE_SNAPSHOT_CONTENT_HASH_MISMATCH', `source snapshot content hash mismatch: ${filePath}`);
    }

    const suppliedBlobSha = String(input.blobSha || input.blob_sha || '').trim();
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

  files.sort(compareSnapshotPaths);
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

function isMarkdownSnapshotPath(filePath) {
  return /\.(?:md|markdown)$/i.test(filePath);
}

function markdownFileWithinTarget(filePath, targetPath) {
  if (isMarkdownSnapshotPath(targetPath)) return filePath === targetPath;
  return filePath.startsWith(`${targetPath}/`);
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
  const rootPath = strictString(data.rootPath || data.workspaceRoot || data.allowedRoot || '', 1024);
  if (!targetPath) {
    return snapshotFailure('SOURCE_SNAPSHOT_PATH_INVALID', 'markdown snapshot path must be relative, canonical, and traversal-free');
  }
  if (!rootPath || /[\u0000-\u001f\u007f]/u.test(rootPath)) { // oxlint-disable-line no-control-regex -- deliberate: rejects the control characters this path boundary refuses
    return snapshotFailure('MARKDOWN_ROOT_REQUIRED', 'markdown snapshot rootPath is required');
  }

  const inputFiles = Array.isArray(data.files)
    ? data.files
    : [{ path: targetPath, content: typeof data.content === 'string' ? data.content : data.text }];
  const normalizedFiles = normalizeExternalSnapshotFiles(inputFiles);
  if (!normalizedFiles.ok) return normalizedFiles;
  if (normalizedFiles.files.some(file => file.blobSha)) {
    return snapshotFailure('SOURCE_SNAPSHOT_BLOB_SHA_UNEXPECTED', 'Git blob SHAs are not valid in markdown snapshots');
  }
  if (normalizedFiles.files.some(file => !isMarkdownSnapshotPath(file.path))) {
    return snapshotFailure('SOURCE_SNAPSHOT_MARKDOWN_REQUIRED', 'markdown snapshots may contain .md or .markdown files only');
  }
  if (normalizedFiles.files.some(file => !markdownFileWithinTarget(file.path, targetPath))) {
    return snapshotFailure('SOURCE_SNAPSHOT_SCOPE_MISMATCH', 'markdown snapshot files must stay within the reviewed target path');
  }

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

module.exports = {
  buildImmutableExternalSourceSnapshot,
  externalSnapshotManifestView,
  finalizeExternalSourceSnapshot,
  isMarkdownSnapshotPath,
  markdownFileWithinTarget,
  normalizeExternalSnapshotFiles,
};
