const { contentHash, CONTENT_HASH_ALGORITHM } = require('../lib/content-hash');
const { buildGitHubBlobUrl, buildGitHubRawUrl } = require('../lib/github-url');
const {
  GITHUB_LIMITS,
  githubLimits,
  toError,
  parseRepoUrl,
  buildHeaders,
  normalizePath,
  isMarkdownPath,
  includePath,
  parseRateLimitError,
} = require('./github-adapter-utils');
const {
  resolveCommitSha,
  fetchTreePayload,
  treeBlobPaths,
  walkTreeBlobPaths,
} = require('./github-tree');

const DEFAULT_FETCH_TIMEOUT_MS = 30000;

async function defaultFetch(url, options) {
  if (typeof fetch !== 'function') {
    throw toError('Global fetch is not available', 'FETCH_UNAVAILABLE');
  }
  const withTimeout = options && options.signal
    ? options
    : { ...options, signal: AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS) };
  return fetch(url, withTimeout);
}

async function readBoundedText(response, filePath, maxFileBytes, remainingBytes) {
  const contentLength = Number(response.headers?.get?.('content-length') || 0);
  const allowed = Math.min(maxFileBytes, remainingBytes);
  if (Number.isFinite(contentLength) && contentLength > allowed) {
    const code = contentLength > maxFileBytes ? 'GITHUB_FILE_BYTES_LIMIT' : 'GITHUB_TOTAL_BYTES_LIMIT';
    throw toError(`GitHub content byte limit exceeded: ${filePath}`, code);
  }
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > allowed) {
          await reader.cancel();
          const code = bytes > maxFileBytes ? 'GITHUB_FILE_BYTES_LIMIT' : 'GITHUB_TOTAL_BYTES_LIMIT';
          throw toError(`GitHub content byte limit exceeded: ${filePath}`, code);
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock?.();
    }
    return { content: Buffer.concat(chunks, bytes).toString('utf8'), bytes };
  }
  const content = await response.text();
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > allowed) {
    const code = bytes > maxFileBytes ? 'GITHUB_FILE_BYTES_LIMIT' : 'GITHUB_TOTAL_BYTES_LIMIT';
    throw toError(`GitHub content byte limit exceeded: ${filePath}`, code);
  }
  return { content, bytes };
}

async function fetchRepoFiles(repoUrl, opts = {}) {
  const { owner, repo } = parseRepoUrl(repoUrl);
  const branch = String(opts.branch || 'main');
  const token = opts.token || '';
  const fetchImpl = opts.fetchImpl || defaultFetch;
  const explicitPaths = Array.isArray(opts.paths) ? opts.paths.map(normalizePath).filter(Boolean) : null;
  const limits = githubLimits(opts);
  const budget = { limits, treeRequests: 0, treeEntries: 0 };

  const commitSha = await resolveCommitSha(owner, repo, branch, token, fetchImpl);

  const treePayload = await fetchTreePayload(owner, repo, commitSha, token, fetchImpl, { recursive: true, budget });
  let paths = treePayload && treePayload.truncated === true
    ? await walkTreeBlobPaths(owner, repo, commitSha, token, fetchImpl, explicitPaths, budget)
    : treeBlobPaths(treePayload);

  if (explicitPaths && explicitPaths.length > 0) {
    const allowSet = new Set(explicitPaths.map(pathItem => pathItem.toLowerCase()));
    paths = paths.filter(item => allowSet.has(item.toLowerCase()) && isMarkdownPath(item));
  } else {
    paths = paths.filter(includePath);
  }

  const dedupedPaths = [...new Set(paths)];
  if (dedupedPaths.length > limits.maxFiles) throw toError('GitHub selected file limit exceeded', 'GITHUB_FILE_COUNT_LIMIT');
  const files = [];
  let totalBytes = 0;
  for (const filePath of dedupedPaths) {
    // Segment-encoded through the shared helper: interpolating the tree path
    // raw let a '#' or '?' in a filename cut the URL short, so the adapter
    // fetched a different resource than the one the tree named -- a 404 the
    // loop below swallows, or worse, bytes hashed under the wrong path (#690).
    const rawUrl = buildGitHubRawUrl({ owner, repo, ref: commitSha, path: filePath });
    const fileRes = await fetchImpl(rawUrl, {
      method: 'GET',
      headers: buildHeaders(token),
    });

    if (!fileRes.ok) {
      if (fileRes.status === 404) {
        const error = toError(
          `GitHub tree-listed file is missing at pinned commit ${commitSha}: ${filePath}`,
          'GITHUB_TREE_FILE_MISSING',
          404,
        );
        error.commitSha = commitSha;
        error.path = filePath;
        throw error;
      }
      throw parseRateLimitError(fileRes, `Failed to fetch file content (${fileRes.status}): ${filePath}`);
    }

    const read = await readBoundedText(fileRes, filePath, limits.maxFileBytes, limits.maxTotalBytes - totalBytes);
    totalBytes += read.bytes;
    const content = read.content;
    const lastModified = fileRes.headers && typeof fileRes.headers.get === 'function'
      ? (fileRes.headers.get('last-modified') || '')
      : '';

    files.push({
      owner,
      repo,
      branch,
      commitSha,
      path: filePath,
      content,
      lastModified: lastModified || new Date().toISOString(),
    });
  }

  return files;
}

async function fetchAndLearn(repoUrl, kernel, opts = {}) {
  const files = await fetchRepoFiles(repoUrl, opts);
  const results = [];
  for (const file of files) {
    // Canonical https URL rather than a compact `owner/repo/path@branch`
    // string: evidence-validator's reachability gate only inspects sourceRef
    // values that look like http(s) URLs, so the compact form meant remote
    // GitHub content slipped past preIngest untouched even with
    // evidenceReachability on (#591). The URL carries the same four facts.
    const provenance = {
      provenanceId: `github-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
      source: 'github-adapter',
      // Built from the resolved commit, not the branch the caller asked for.
      sourceRef: buildGitHubBlobUrl({ ...file, branch: file.commitSha || file.branch }),
      sourceType: 'github',
      sourceSubType: 'blob',
      sourceVersion: file.commitSha || '',
      sourceVersionKind: file.commitSha ? 'commit_sha' : '',
      contentHash: contentHash(file.content),
      contentHashAlgorithm: CONTENT_HASH_ALGORITHM,
      actor: opts.actor || 'github-adapter',
      timestamp: new Date().toISOString(),
    };
    try {
      // learnAsync: this is remote-sourced content too, so preIngest gates
      // must get a look at it (#348). No `typeof` fallback to the sync path,
      // for the same reason as http-adapter -- a silent skip is the bug.
      const r = await kernel.learnAsync(file.content, { provenance, sourceType: 'github', sourceSubType: 'blob', sourceRef: provenance.sourceRef });
      results.push({ path: file.path, learned: r.data.learned, ok: true });
    } catch (e) {
      results.push({ path: file.path, error: e.message, ok: false });
    }
  }
  return { files, learned: results };
}

module.exports = {
  GITHUB_LIMITS,
  fetchRepoFiles,
  fetchAndLearn,
  parseRepoUrl,
  includePath,
  isMarkdownPath,
};
