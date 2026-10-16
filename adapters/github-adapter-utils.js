const { canonicalizeGitHubRepoUrl } = require('../lib/github-url');

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

module.exports = {
  GITHUB_LIMITS,
  githubLimits,
  toError,
  parseRepoUrl,
  buildHeaders,
  normalizePath,
  isMarkdownPath,
  includePath,
  parseRateLimitError,
};
