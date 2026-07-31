'use strict';

const GITHUB_WEB_PROTOCOLS = new Set(['https:', 'http:', 'git+https:', 'ssh:']);
const GITHUB_WEB_HOSTS = new Set(['github.com', 'www.github.com']);

function invalidRepoUrl(message = 'Invalid GitHub repository URL') {
  const error = new Error(message);
  error.code = 'REPO_URL_INVALID';
  return error;
}

function decodeSegment(segment) {
  let decoded;
  try {
    decoded = decodeURIComponent(segment);
  } catch (_) {
    throw invalidRepoUrl();
  }
  if (!decoded || /[/?#\\\s]/.test(decoded)) throw invalidRepoUrl();
  return decoded;
}

function canonicalizeGitHubRepoUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    const error = new Error('repoUrl is required');
    error.code = 'REPO_URL_REQUIRED';
    throw error;
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    throw invalidRepoUrl();
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com' || parsed.username || parsed.password) {
    throw invalidRepoUrl();
  }

  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 2) throw invalidRepoUrl();
  const owner = decodeSegment(parts[0]);
  const repo = decodeSegment(parts[1]).replace(/\.git$/i, '');
  if (!repo) throw invalidRepoUrl();

  return { owner, repo, repoUrl: `https://github.com/${owner}/${repo}` };
}

function redactGitHubSourceRef(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    return '';
  }

  const protocol = parsed.protocol.toLowerCase();
  const hostname = parsed.hostname.toLowerCase();
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';

  if (protocol === 'github:' && raw.toLowerCase().startsWith('github://')) {
    return parsed.toString();
  }
  if (!GITHUB_WEB_PROTOCOLS.has(protocol) || !GITHUB_WEB_HOSTS.has(hostname)) {
    return '';
  }
  return `https://github.com${parsed.pathname}`;
}

module.exports = {
  canonicalizeGitHubRepoUrl,
  redactGitHubSourceRef,
};
