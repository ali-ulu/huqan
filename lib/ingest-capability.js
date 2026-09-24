// #2171: the ingest capability payload -- idempotency key, canonical source
// reference and the payload the runtime executes.

const { hashText, sanitizeString } = require('./ingest-values');

const { canonicalizeGitHubRepoUrl } = require('./github-url');
function buildIdempotencyKey(data, sourceType, sourceRef) {
  const provided = sanitizeString(data.idempotencyKey || data.idempotency_key || '', 128);
  if (provided) return provided;
  const base = `${sourceType}:${sourceRef || hashText(JSON.stringify(data || {}))}`;
  return hashText(base);
}

function safeCanonicalizeGitHubRepoUrl(data = {}) {
  try {
    return { ok: true, ...canonicalizeGitHubRepoUrl(data.repoUrl || data.url || '') };
  } catch (error) {
    return {
      ok: false,
      code: error?.code || 'REPO_URL_INVALID',
      error: error?.message || 'Invalid GitHub repository URL',
    };
  }
}

function buildSourceRef(data, sourceType) {
  if (sourceType === 'github') {
    const canonical = safeCanonicalizeGitHubRepoUrl(data);
    if (!canonical.ok) return '';
    const repoUrl = canonical.repoUrl;
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
    const canonical = safeCanonicalizeGitHubRepoUrl(data);
    if (!canonical.ok) return null;
    return {
      ...base,
      repoUrl: canonical.repoUrl,
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

module.exports = {
  buildCapabilityPayload,
  buildIdempotencyKey,
  buildSourceRef,
  safeCanonicalizeGitHubRepoUrl,
};
