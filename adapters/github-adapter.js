function toError(message, code, status) {
  const err = new Error(message);
  if (code) err.code = code;
  if (typeof status === 'number') err.status = status;
  return err;
}

function parseRepoUrl(repoUrl) {
  const raw = String(repoUrl || '').trim();
  if (!raw) {
    throw toError('repoUrl is required', 'REPO_URL_REQUIRED');
  }

  const match = raw.match(/^https:\/\/github\.com\/([^\/]+)\/([^\/?#]+?)(?:\.git)?(?:[\/?#].*)?$/i);
  if (!match) {
    throw toError('Invalid GitHub repository URL', 'REPO_URL_INVALID');
  }

  return {
    owner: decodeURIComponent(match[1]),
    repo: decodeURIComponent(match[2].replace(/\.git$/i, '')),
  };
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

function includePath(filePath) {
  const normalized = normalizePath(filePath);
  const lower = normalized.toLowerCase();
  if (!lower.endsWith('.md')) return false;

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

async function defaultFetch(url, options) {
  if (typeof fetch !== 'function') {
    throw toError('Global fetch is not available', 'FETCH_UNAVAILABLE');
  }
  return fetch(url, options);
}

async function fetchRepoFiles(repoUrl, opts = {}) {
  const { owner, repo } = parseRepoUrl(repoUrl);
  const branch = String(opts.branch || 'main');
  const token = opts.token || '';
  const fetchImpl = opts.fetchImpl || defaultFetch;
  const explicitPaths = Array.isArray(opts.paths) ? opts.paths.map(normalizePath).filter(Boolean) : null;

  const treeUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
  const treeRes = await fetchImpl(treeUrl, {
    method: 'GET',
    headers: buildHeaders(token),
  });

  if (!treeRes.ok) {
    throw parseRateLimitError(treeRes, `Failed to fetch repository tree (${treeRes.status})`);
  }

  const treePayload = await treeRes.json();
  const tree = Array.isArray(treePayload.tree) ? treePayload.tree : [];
  let paths = tree
    .filter(item => item && item.type === 'blob' && typeof item.path === 'string')
    .map(item => normalizePath(item.path));

  if (explicitPaths && explicitPaths.length > 0) {
    const allowSet = new Set(explicitPaths.map(pathItem => pathItem.toLowerCase()));
    paths = paths.filter(item => allowSet.has(item.toLowerCase()));
  } else {
    paths = paths.filter(includePath);
  }

  const dedupedPaths = [...new Set(paths)];
  const files = [];
  for (const filePath of dedupedPaths) {
    const rawUrl = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}/${filePath}`;
    const fileRes = await fetchImpl(rawUrl, {
      method: 'GET',
      headers: buildHeaders(token),
    });

    if (!fileRes.ok) {
      if (fileRes.status === 404) continue;
      throw parseRateLimitError(fileRes, `Failed to fetch file content (${fileRes.status}): ${filePath}`);
    }

    const content = await fileRes.text();
    const lastModified = fileRes.headers && typeof fileRes.headers.get === 'function'
      ? (fileRes.headers.get('last-modified') || '')
      : '';

    files.push({
      owner,
      repo,
      branch,
      path: filePath,
      content,
      lastModified: lastModified || new Date().toISOString(),
    });
  }

  return files;
}

module.exports = {
  fetchRepoFiles,
  parseRepoUrl,
  includePath,
};
