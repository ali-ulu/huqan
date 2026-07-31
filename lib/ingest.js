const crypto = require('crypto');
const { canonicalizeGitHubRepoUrl } = require('./github-url');

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
  sanitizeString,
  normalizeSourceType,
  buildIdempotencyKey,
  buildSourceRef,
  buildCapabilityPayload,
  buildIngestApprovalSnapshot,
  stableStringify,
  sha256,
  handleIngest,
};
