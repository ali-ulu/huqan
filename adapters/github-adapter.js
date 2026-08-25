const { contentHash, CONTENT_HASH_ALGORITHM } = require('../lib/content-hash');
const { canonicalizeGitHubRepoUrl, buildGitHubBlobUrl, buildGitHubRawUrl } = require('../lib/github-url');

function toError(message, code, status) {
  const err = new Error(message);
  if (code) err.code = code;
  if (typeof status === 'number') err.status = status;
  return err;
}

function parseRepoUrl(repoUrl) {
  const { owner, repo } = canonicalizeGitHubRepoUrl(repoUrl);
  return { owner, repo };
}

function buildHeaders(token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'axiom-company-brain',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function normalizePath(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

/**
 * Extension rule, split out of includePath() so both selection branches can
 * apply it. Explicit caller paths may narrow *where* files come from, but they
 * must never widen *which types* are ingested (#1508).
 */
function isMarkdownPath(filePath) {
  return normalizePath(filePath).toLowerCase().endsWith('.md');
}

function includePath(filePath) {
  const normalized = normalizePath(filePath);
  const lower = normalized.toLowerCase();
  if (!isMarkdownPath(normalized)) return false;

  if (lower === 'readme.md' || lower === 'contributing.md' || lower === 'roadmap.md') return true;
  if (lower.startsWith('.github/')) return true;
  if (!normalized.includes('/')) return true;

  return false;
}

function parseRateLimitError(res, fallbackMessage) {
  if (res.status === 403 || res.status === 429) {
    return toError('GitHub rate limit exceeded', 'GITHUB_RATE_LIMIT', res.status);
  }
  return toError(fallbackMessage, 'GITHUB_REQUEST_FAILED', res.status);
}

const DEFAULT_FETCH_TIMEOUT_MS = 30000;
const GITHUB_LIMITS = Object.freeze({
  maxTreeRequests: 1_000,
  maxTreeEntries: 100_000,
  maxFiles: 1_000,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 10 * 1024 * 1024,
});

function githubLimits(options = {}) {
  const limits = {};
  for (const [name, fallback] of Object.entries(GITHUB_LIMITS)) {
    const value = options[name] === undefined ? fallback : options[name];
    if (!Number.isSafeInteger(value) || value <= 0) throw toError(`${name} must be a positive safe integer`, 'GITHUB_INVALID_LIMIT');
    limits[name] = value;
  }
  return limits;
}

async function defaultFetch(url, options) {
  if (typeof fetch !== 'function') {
    throw toError('Global fetch is not available', 'FETCH_UNAVAILABLE');
  }
  const withTimeout = options && options.signal
    ? options
    : { ...options, signal: AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS) };
  return fetch(url, withTimeout);
}

/**
 * Resolve a branch (or tag, or SHA) to the commit it names right now.
 *
 * Everything downstream addresses content by this SHA rather than by the branch.
 * A branch is a moving target: recording `blob/main/README.md` produces a
 * reference that keeps resolving after the content behind it changes, so a
 * reader following the receipt gets today's file and compares it against a hash
 * taken from a different one. Costs one API call, and buys a reference that
 * still means what it meant.
 */
async function resolveCommitSha(owner, repo, ref, token, fetchImpl) {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`;
  const res = await fetchImpl(url, { method: 'GET', headers: buildHeaders(token) });
  if (!res.ok) {
    throw parseRateLimitError(res, `Failed to resolve ref to a commit (${res.status}): ${ref}`);
  }
  const payload = await res.json();
  const sha = payload && typeof payload.sha === 'string' ? payload.sha.trim() : '';
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    // Fail rather than fall back to the branch name: a silent fallback is how a
    // record ends up naming a version it never read.
    throw toError(`GitHub did not return a commit SHA for ref: ${ref}`, 'GITHUB_REF_UNRESOLVED');
  }
  return sha;
}

async function fetchTreePayload(owner, repo, treeSha, token, fetchImpl, { recursive = false, budget } = {}) {
  if (budget) {
    budget.treeRequests += 1;
    if (budget.treeRequests > budget.limits.maxTreeRequests) throw toError('GitHub tree request limit exceeded', 'GITHUB_TREE_WORK_LIMIT');
  }
  const treeUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(treeSha)}${recursive ? '?recursive=1' : ''}`;
  const treeRes = await fetchImpl(treeUrl, {
    method: 'GET',
    headers: buildHeaders(token),
  });

  if (!treeRes.ok) {
    throw parseRateLimitError(treeRes, `Failed to fetch repository tree (${treeRes.status})`);
  }

  const payload = await treeRes.json();
  if (budget) {
    budget.treeEntries += Array.isArray(payload?.tree) ? payload.tree.length : 0;
    if (budget.treeEntries > budget.limits.maxTreeEntries) throw toError('GitHub tree entry limit exceeded', 'GITHUB_TREE_WORK_LIMIT');
  }
  return payload;
}

function treeBlobPaths(treePayload, prefix = '') {
  const tree = Array.isArray(treePayload && treePayload.tree) ? treePayload.tree : [];
  return tree
    .filter(item => item && item.type === 'blob' && typeof item.path === 'string')
    .map(item => normalizePath(prefix ? `${prefix}/${item.path}` : item.path));
}

/**
 * Can a path the caller asked for live under this directory?
 *
 * Only used to bound the walk below. With explicit paths the answer is exact.
 * With the default filter, includePath() accepts root blobs and anything under
 * `.github/`, so no other subtree can contribute a file and none is entered.
 */
function subtreeCanContainWantedPaths(dirPath, explicitPaths) {
  const lower = `${dirPath.toLowerCase()}/`;
  if (explicitPaths && explicitPaths.length > 0) {
    return explicitPaths.some(item => item.toLowerCase().startsWith(lower));
  }
  return lower === '.github/' || lower.startsWith('.github/');
}

/**
 * Enumerate blobs one directory at a time, entering only the subtrees that can
 * still hold a wanted path.
 *
 * The single `?recursive=1` call is cheaper and is still the normal path. But
 * GitHub answers it with `truncated: true` once a repository is large enough,
 * and a truncated tree is a partial tree that looks exactly like a complete
 * one: the adapter used to read `treePayload.tree` and return the surviving
 * subset as a successful, apparently full scan (#689). Failing there would be
 * honest but would make large repositories unreadable, so the truncation is
 * repaired instead -- and a subtree that is itself truncated, which no walk can
 * repair, fails closed rather than returning a quietly short list.
 */
async function walkTreeBlobPaths(owner, repo, commitSha, token, fetchImpl, explicitPaths, budget) {
  const paths = [];
  const queue = [{ path: '', sha: commitSha }];
  const visited = new Set();

  while (queue.length > 0) {
    const dir = queue.shift();
    if (visited.has(dir.path)) continue;
    visited.add(dir.path);

    const payload = await fetchTreePayload(owner, repo, dir.sha, token, fetchImpl, { budget });
    if (payload && payload.truncated === true) {
      throw toError(
        `GitHub returned a truncated tree for a single directory, so the file list cannot be completed: ${dir.path || '<root>'}`,
        'GITHUB_TREE_TRUNCATED',
      );
    }

    for (const path of treeBlobPaths(payload, dir.path)) paths.push(path);

    const entries = Array.isArray(payload && payload.tree) ? payload.tree : [];
    for (const item of entries) {
      if (!item || item.type !== 'tree' || typeof item.path !== 'string') continue;
      const childPath = normalizePath(dir.path ? `${dir.path}/${item.path}` : item.path);
      if (!subtreeCanContainWantedPaths(childPath, explicitPaths)) continue;
      if (typeof item.sha !== 'string' || !item.sha) {
        throw toError(
          `GitHub returned a tree entry without a sha, so its contents cannot be listed: ${childPath}`,
          'GITHUB_TREE_INCOMPLETE',
        );
      }
      queue.push({ path: childPath, sha: item.sha });
    }
  }

  return paths;
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
