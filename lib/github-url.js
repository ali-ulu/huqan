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

/**
 * Encode a repository-relative path for the path portion of a URL, one segment
 * at a time.
 *
 * Both failure modes this avoids are silent. encodeURIComponent over the whole
 * path escapes the '/' separators and collapses the path into a single segment,
 * so the URL no longer addresses the file. Interpolating the path raw lets a
 * character that is legal in a Git filename but meaningful in a URL end the
 * path early: `notes#draft.md` requests `notes` with `#draft.md` left in the
 * fragment, `notes?draft.md` moves the tail into the query (#690). Neither
 * produces an error at build time -- the request just addresses something else.
 *
 * Every GitHub URL this module builds, and every raw-content URL built from a
 * tree path, goes through here so the two cannot drift apart.
 */
function encodeGitHubPathSegments(path) {
  return String(path || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
}

/**
 * Canonical web URL for one file at one ref: the form evidence gates can
 * actually act on. A compact `owner/repo/path@branch` reference carries the
 * same facts but is not an http(s) URL, so the reachability gate in
 * plugins/evidence-validator.js skips it silently (#591).
 */
function buildGitHubBlobUrl({ owner, repo, branch, path }) {
  const encodedPath = encodeGitHubPathSegments(path);
  if (!owner || !repo || !branch || !encodedPath) {
    throw invalidRepoUrl('Cannot build a GitHub blob URL without owner, repo, branch and path');
  }
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/blob/${encodeURIComponent(branch)}/${encodedPath}`;
}

/**
 * Raw-content URL for one file at one commit. Same segment semantics as
 * buildGitHubBlobUrl by construction: the fetch path and the provenance path
 * must canonicalize a filename identically, or the bytes that get hashed come
 * from a URL the recorded reference does not name (#690).
 */
function buildGitHubRawUrl({ owner, repo, ref, path }) {
  const encodedPath = encodeGitHubPathSegments(path);
  if (!owner || !repo || !ref || !encodedPath) {
    throw invalidRepoUrl('Cannot build a GitHub raw URL without owner, repo, ref and path');
  }
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}/${encodedPath}`;
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
  encodeGitHubPathSegments,
  buildGitHubBlobUrl,
  buildGitHubRawUrl,
  redactGitHubSourceRef,
};
