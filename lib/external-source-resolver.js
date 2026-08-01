'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');

const { includePath } = require('../adapters/github-adapter');
const { canonicalizeGitHubRepoUrl } = require('./github-url');
const { resolvePathWithinRoot } = require('./path-safety');
const {
  MAX_EXTERNAL_SNAPSHOT_FILES,
  MAX_EXTERNAL_SNAPSHOT_BYTES,
  buildImmutableExternalSourceSnapshot,
  normalizeGitHubCommitSha,
  normalizeSnapshotPath,
} = require('./ingest');

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function resolverError(message, code, status) {
  const error = new Error(message);
  error.code = code;
  if (typeof status === 'number') error.status = status;
  return error;
}

function resolverFailure(error, fallbackCode = 'SOURCE_RESOLUTION_FAILED') {
  return {
    ok: false,
    code: error?.code || fallbackCode,
    error: error?.message || String(error || 'source resolution failed'),
  };
}

function buildGitHubHeaders(token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'huqan-source-snapshot-resolver',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function defaultFetch(url, options) {
  if (typeof fetch !== 'function') {
    throw resolverError('Global fetch is not available', 'FETCH_UNAVAILABLE');
  }
  return fetch(url, options);
}

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizeRequestedPaths(paths) {
  if (paths == null) return { ok: true, paths: null };
  if (!Array.isArray(paths) || paths.length === 0) {
    return { ok: false, code: 'SOURCE_SNAPSHOT_PATHS_INVALID', error: 'paths must be a non-empty array when provided' };
  }
  if (paths.length > MAX_EXTERNAL_SNAPSHOT_FILES) {
    return { ok: false, code: 'SOURCE_SNAPSHOT_FILE_LIMIT', error: `at most ${MAX_EXTERNAL_SNAPSHOT_FILES} paths may be requested` };
  }

  const seen = new Set();
  const normalized = [];
  for (const value of paths) {
    const filePath = normalizeSnapshotPath(value);
    if (!filePath) {
      return { ok: false, code: 'SOURCE_SNAPSHOT_PATH_INVALID', error: 'requested paths must be canonical relative paths' };
    }
    const key = filePath.normalize('NFC').toLowerCase();
    if (seen.has(key)) {
      return { ok: false, code: 'SOURCE_SNAPSHOT_PATH_DUPLICATE', error: `duplicate requested path: ${filePath}` };
    }
    seen.add(key);
    normalized.push(filePath);
  }
  normalized.sort(compareStrings);
  return { ok: true, paths: normalized };
}

async function readJsonResponse(response, context) {
  if (!response || typeof response.ok !== 'boolean') {
    throw resolverError(`Invalid GitHub response while ${context}`, 'GITHUB_RESPONSE_INVALID');
  }
  if (!response.ok) {
    const status = Number(response.status || 0);
    const code = status === 403 || status === 429 ? 'GITHUB_RATE_LIMIT' : 'GITHUB_REQUEST_FAILED';
    throw resolverError(`GitHub request failed while ${context} (${status || 'unknown'})`, code, status);
  }
  try {
    return await response.json();
  } catch (_) {
    throw resolverError(`GitHub returned invalid JSON while ${context}`, 'GITHUB_RESPONSE_INVALID');
  }
}

function decodeGitBlob(payload, expectedBlobSha, filePath, maxBytes = MAX_EXTERNAL_SNAPSHOT_BYTES) {
  const returnedSha = normalizeGitHubCommitSha(payload?.sha || '');
  if (!returnedSha || returnedSha !== expectedBlobSha) {
    throw resolverError(`GitHub blob identity mismatch: ${filePath}`, 'GITHUB_BLOB_IDENTITY_MISMATCH');
  }
  if (payload?.encoding !== 'base64' || typeof payload?.content !== 'string') {
    throw resolverError(`GitHub blob encoding is unsupported: ${filePath}`, 'GITHUB_BLOB_ENCODING_UNSUPPORTED');
  }

  const byteLimit = Number.isSafeInteger(maxBytes) && maxBytes >= 0
    ? maxBytes
    : MAX_EXTERNAL_SNAPSHOT_BYTES;
  const declaredSize = Number(payload?.size);
  if (Number.isFinite(declaredSize) && declaredSize > byteLimit) {
    throw resolverError(`GitHub blob exceeds the remaining snapshot byte limit: ${filePath}`, 'SOURCE_SNAPSHOT_SIZE_LIMIT');
  }

  const compact = payload.content.replace(/\s+/g, '');
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw resolverError(`GitHub blob base64 is invalid: ${filePath}`, 'GITHUB_BLOB_ENCODING_INVALID');
  }
  const maxEncodedLength = 4 * Math.ceil(byteLimit / 3);
  if (compact.length > maxEncodedLength) {
    throw resolverError(`GitHub blob exceeds the remaining snapshot byte limit: ${filePath}`, 'SOURCE_SNAPSHOT_SIZE_LIMIT');
  }
  const bytes = Buffer.from(compact, 'base64');
  if (bytes.length > byteLimit) {
    throw resolverError(`GitHub blob exceeds the remaining snapshot byte limit: ${filePath}`, 'SOURCE_SNAPSHOT_SIZE_LIMIT');
  }
  const canonical = bytes.toString('base64').replace(/=+$/u, '');
  if (canonical !== compact.replace(/=+$/u, '')) {
    throw resolverError(`GitHub blob base64 is non-canonical: ${filePath}`, 'GITHUB_BLOB_ENCODING_INVALID');
  }

  const gitObjectHeader = Buffer.from(`blob ${bytes.length}\0`, 'utf8');
  const computedBlobSha = crypto.createHash('sha1').update(gitObjectHeader).update(bytes).digest('hex');
  if (computedBlobSha !== expectedBlobSha) {
    throw resolverError(`GitHub blob content does not match its tree identity: ${filePath}`, 'GITHUB_BLOB_CONTENT_MISMATCH');
  }

  try {
    return { content: UTF8_DECODER.decode(bytes), sizeBytes: bytes.length };
  } catch (_) {
    throw resolverError(`GitHub blob is not valid UTF-8 text: ${filePath}`, 'SOURCE_SNAPSHOT_UTF8_REQUIRED');
  }
}

async function resolveGitHubSourceSnapshot(input = {}, options = {}) {
  try {
    const canonicalRepo = canonicalizeGitHubRepoUrl(input.repoUrl || input.url || '');
    const commitSha = normalizeGitHubCommitSha(input.commitSha || input.sha || input.oid || '');
    if (!commitSha) {
      throw resolverError('A full 40-character Git commit SHA is required', 'IMMUTABLE_SOURCE_ID_REQUIRED');
    }

    const requested = normalizeRequestedPaths(input.paths);
    if (!requested.ok) return requested;

    const fetchImpl = options.fetchImpl || input.fetchImpl || defaultFetch;
    const token = options.token || input.token || '';
    const headers = buildGitHubHeaders(token);
    const apiBase = `https://api.github.com/repos/${encodeURIComponent(canonicalRepo.owner)}/${encodeURIComponent(canonicalRepo.repo)}`;

    const commitPayload = await readJsonResponse(await fetchImpl(`${apiBase}/git/commits/${commitSha}`, {
      method: 'GET',
      headers,
    }), 'resolving commit');
    const returnedCommitSha = normalizeGitHubCommitSha(commitPayload?.sha || '');
    const treeSha = normalizeGitHubCommitSha(commitPayload?.tree?.sha || '');
    if (returnedCommitSha !== commitSha || !treeSha) {
      throw resolverError('GitHub commit identity could not be proven', 'GITHUB_COMMIT_IDENTITY_MISMATCH');
    }

    const treePayload = await readJsonResponse(await fetchImpl(`${apiBase}/git/trees/${treeSha}?recursive=1`, {
      method: 'GET',
      headers,
    }), 'resolving commit tree');
    const returnedTreeSha = normalizeGitHubCommitSha(treePayload?.sha || '');
    if (returnedTreeSha !== treeSha) {
      throw resolverError('GitHub tree identity could not be proven', 'GITHUB_TREE_IDENTITY_MISMATCH');
    }
    if (treePayload?.truncated === true) {
      throw resolverError('GitHub recursive tree was truncated', 'GITHUB_TREE_TRUNCATED');
    }

    const blobByPath = new Map();
    for (const item of Array.isArray(treePayload?.tree) ? treePayload.tree : []) {
      if (!item || item.type !== 'blob') continue;
      const filePath = normalizeSnapshotPath(item.path || '');
      const blobSha = normalizeGitHubCommitSha(item.sha || '');
      const mode = String(item.mode || '');
      if (!filePath || !blobSha) {
        throw resolverError('GitHub tree contains an invalid blob entry', 'GITHUB_TREE_INVALID');
      }
      if (mode !== '100644' && mode !== '100755') {
        throw resolverError(`GitHub tree mode is unsupported for snapshot ingestion: ${filePath}`, 'GITHUB_TREE_MODE_UNSUPPORTED');
      }
      const key = filePath.normalize('NFC').toLowerCase();
      if (blobByPath.has(key)) {
        throw resolverError(`GitHub tree contains duplicate path identity: ${filePath}`, 'GITHUB_TREE_PATH_DUPLICATE');
      }
      blobByPath.set(key, { path: filePath, blobSha });
    }

    let selected;
    if (requested.paths) {
      selected = [];
      for (const requestedPath of requested.paths) {
        const item = blobByPath.get(requestedPath.normalize('NFC').toLowerCase());
        if (!item) {
          throw resolverError(`Requested GitHub path was not found at the reviewed commit: ${requestedPath}`, 'SOURCE_SNAPSHOT_PATH_NOT_FOUND');
        }
        selected.push(item);
      }
    } else {
      selected = [...blobByPath.values()].filter(item => includePath(item.path));
    }
    selected.sort((left, right) => compareStrings(left.path, right.path));

    if (selected.length === 0) {
      throw resolverError('No eligible GitHub source files were found at the reviewed commit', 'SOURCE_SNAPSHOT_FILES_REQUIRED');
    }
    if (selected.length > MAX_EXTERNAL_SNAPSHOT_FILES) {
      throw resolverError(`Resolved GitHub snapshot exceeds ${MAX_EXTERNAL_SNAPSHOT_FILES} files`, 'SOURCE_SNAPSHOT_FILE_LIMIT');
    }

    const files = [];
    let totalBytes = 0;
    for (const item of selected) {
      const blobPayload = await readJsonResponse(await fetchImpl(`${apiBase}/git/blobs/${item.blobSha}`, {
        method: 'GET',
        headers,
      }), `resolving blob ${item.path}`);
      const remainingBytes = MAX_EXTERNAL_SNAPSHOT_BYTES - totalBytes;
      const decoded = decodeGitBlob(blobPayload, item.blobSha, item.path, remainingBytes);
      totalBytes += decoded.sizeBytes;
      if (totalBytes > MAX_EXTERNAL_SNAPSHOT_BYTES) {
        throw resolverError(`Resolved GitHub snapshot exceeds ${MAX_EXTERNAL_SNAPSHOT_BYTES} bytes`, 'SOURCE_SNAPSHOT_SIZE_LIMIT');
      }
      files.push({
        path: item.path,
        content: decoded.content,
        blobSha: item.blobSha,
      });
    }

    return buildImmutableExternalSourceSnapshot({
      sourceType: 'github',
      repoUrl: canonicalRepo.repoUrl,
      commitSha,
      files,
    });
  } catch (error) {
    return resolverFailure(error, 'GITHUB_SOURCE_RESOLUTION_FAILED');
  }
}

function isMarkdownPath(filePath) {
  return /\.(?:md|markdown)$/i.test(filePath);
}

function listMarkdownFilesWithoutSymlinks(absRoot, absTarget) {
  const files = [];

  function visit(currentPath) {
    const stat = fs.lstatSync(currentPath);
    if (stat.isSymbolicLink()) {
      throw resolverError('Markdown snapshot resolution refuses symbolic links', 'MARKDOWN_SYMLINK_UNSUPPORTED');
    }
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(currentPath).slice().sort(compareStrings);
      for (const entry of entries) visit(path.join(currentPath, entry));
      return;
    }
    if (stat.isFile() && isMarkdownPath(currentPath)) {
      files.push(currentPath);
      if (files.length > MAX_EXTERNAL_SNAPSHOT_FILES) {
        throw resolverError(`Resolved Markdown snapshot exceeds ${MAX_EXTERNAL_SNAPSHOT_FILES} files`, 'SOURCE_SNAPSHOT_FILE_LIMIT');
      }
    }
  }

  visit(absTarget);
  return files.sort(compareStrings).map(filePath => {
    const relative = path.relative(absRoot, filePath).split(path.sep).join('/');
    const normalized = normalizeSnapshotPath(relative);
    if (!normalized) {
      throw resolverError('Markdown file path is not canonical', 'SOURCE_SNAPSHOT_PATH_INVALID');
    }
    return { absolutePath: filePath, relativePath: normalized };
  });
}

function readStableUtf8File(filePath, maxBytes = MAX_EXTERNAL_SNAPSHOT_BYTES) {
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) {
      throw resolverError('Markdown snapshot entry is not a regular file', 'MARKDOWN_FILE_INVALID');
    }
    const byteLimit = Number.isSafeInteger(maxBytes) && maxBytes >= 0
      ? maxBytes
      : MAX_EXTERNAL_SNAPSHOT_BYTES;
    if (before.size > byteLimit) {
      throw resolverError('Markdown source exceeds the remaining snapshot byte limit', 'SOURCE_SNAPSHOT_SIZE_LIMIT');
    }
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || bytes.length !== after.size
    ) {
      throw resolverError('Markdown source changed during snapshot resolution', 'SOURCE_CHANGED_DURING_RESOLUTION');
    }
    try {
      return { content: UTF8_DECODER.decode(bytes), sizeBytes: bytes.length };
    } catch (_) {
      throw resolverError('Markdown source must be valid UTF-8 text', 'SOURCE_SNAPSHOT_UTF8_REQUIRED');
    }
  } finally {
    fs.closeSync(fd);
  }
}

function resolveMarkdownSourceSnapshot(input = {}) {
  try {
    const targetPath = normalizeSnapshotPath(input.path || input.targetPath || '');
    if (!targetPath) {
      throw resolverError('Markdown target path must be canonical and relative', 'SOURCE_SNAPSHOT_PATH_INVALID');
    }
    if (!input.rootPath && !input.workspaceRoot && !input.allowedRoot) {
      throw resolverError('Markdown rootPath is required', 'MARKDOWN_ROOT_REQUIRED');
    }

    const requestedRoot = path.resolve(String(input.rootPath || input.workspaceRoot || input.allowedRoot));
    const absRoot = fs.realpathSync(requestedRoot);
    const unresolvedTarget = resolvePathWithinRoot(absRoot, path.resolve(absRoot, targetPath), { allowMissing: true });
    if (!fs.existsSync(unresolvedTarget)) {
      throw resolverError('Markdown target does not exist', 'MARKDOWN_SOURCE_NOT_FOUND');
    }
    if (fs.lstatSync(unresolvedTarget).isSymbolicLink()) {
      throw resolverError('Markdown snapshot resolution refuses symbolic links', 'MARKDOWN_SYMLINK_UNSUPPORTED');
    }
    const absTarget = resolvePathWithinRoot(absRoot, unresolvedTarget);

    const listed = listMarkdownFilesWithoutSymlinks(absRoot, absTarget);
    if (listed.length === 0) {
      throw resolverError('No Markdown source files were found', 'SOURCE_SNAPSHOT_FILES_REQUIRED');
    }
    if (listed.length > MAX_EXTERNAL_SNAPSHOT_FILES) {
      throw resolverError(`Resolved Markdown snapshot exceeds ${MAX_EXTERNAL_SNAPSHOT_FILES} files`, 'SOURCE_SNAPSHOT_FILE_LIMIT');
    }

    const files = [];
    let totalBytes = 0;
    for (const item of listed) {
      const resolved = resolvePathWithinRoot(absRoot, item.absolutePath);
      const remainingBytes = MAX_EXTERNAL_SNAPSHOT_BYTES - totalBytes;
      const read = readStableUtf8File(resolved, remainingBytes);
      totalBytes += read.sizeBytes;
      if (totalBytes > MAX_EXTERNAL_SNAPSHOT_BYTES) {
        throw resolverError(`Resolved Markdown snapshot exceeds ${MAX_EXTERNAL_SNAPSHOT_BYTES} bytes`, 'SOURCE_SNAPSHOT_SIZE_LIMIT');
      }
      files.push({ path: item.relativePath, content: read.content });
    }

    return buildImmutableExternalSourceSnapshot({
      sourceType: 'markdown',
      rootPath: absRoot,
      path: targetPath,
      files,
    });
  } catch (error) {
    return resolverFailure(error, 'MARKDOWN_SOURCE_RESOLUTION_FAILED');
  }
}

module.exports = {
  resolveGitHubSourceSnapshot,
  resolveMarkdownSourceSnapshot,
  normalizeRequestedPaths,
  decodeGitBlob,
  readStableUtf8File,
};
